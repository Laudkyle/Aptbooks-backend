const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { env, validateRuntimeEnv } = require('../config/env');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations', 'sql');

function parseArgs(argv) {
  const args = { dryRun: false, reset: false, forceReset: false, baseline: '', dir: MIGRATIONS_DIR };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--reset') args.reset = true;
    else if (arg === '--force-reset') args.forceReset = true;
    else if (arg === '--baseline') { args.baseline = argv[i + 1] || ''; i += 1; }
    else if (arg === '--dir') { args.dir = argv[i + 1] || args.dir; i += 1; }
  }
  return args;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readMigrationFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
}

function normalizeMigrationSql(sql) {
  let normalized = String(sql || '').replace(/^\uFEFF/, '').trim();
  // Older AptBooks migrations often wrapped the whole file in BEGIN/COMMIT.
  // Strip only a single outer wrapper so the runner can make the schema change
  // and schema_migrations ledger entry one atomic transaction.
  if (/^BEGIN\s*;/i.test(normalized) && /COMMIT\s*;\s*$/i.test(normalized)) {
    normalized = normalized.replace(/^BEGIN\s*;\s*/i, '').replace(/\s*COMMIT\s*;\s*$/i, '').trim();
  }
  return normalized;
}

async function acquireLock(client) {
  await client.query('SELECT pg_advisory_lock($1::bigint)', [env.MIGRATION_LOCK_ID]);
}
async function releaseLock(client) {
  await client.query('SELECT pg_advisory_unlock($1::bigint)', [env.MIGRATION_LOCK_ID]);
}

async function ensureSchemaMigrations(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum_sha256 TEXT,
      execution_ms INTEGER,
      application_version TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT`);
  await client.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS execution_ms INTEGER`);
  await client.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS application_version TEXT`);
}

async function loadApplied(client) {
  const { rows } = await client.query('SELECT id, checksum_sha256 FROM schema_migrations ORDER BY id');
  return new Map(rows.map((row) => [row.id, row.checksum_sha256 || null]));
}

async function verifyAndBackfillChecksums(client, files, dir, applied) {
  for (const [id, storedChecksum] of applied.entries()) {
    if (!files.includes(id)) {
      throw new Error(`Applied migration is missing from the repository: ${id}`);
    }
    const raw = fs.readFileSync(path.join(dir, id), 'utf8');
    const checksum = sha256(raw);
    if (!storedChecksum) {
      await client.query('UPDATE schema_migrations SET checksum_sha256=$2 WHERE id=$1 AND checksum_sha256 IS NULL', [id, checksum]);
    } else if (storedChecksum !== checksum) {
      throw new Error(`Applied migration was modified after release: ${id}`);
    }
  }
}

async function baselineUpTo(client, files, baselineFile, dir) {
  if (!baselineFile) return;
  const index = files.indexOf(baselineFile);
  if (index === -1) throw new Error(`Baseline file not found in migrations dir: ${baselineFile}`);
  for (let i = 0; i <= index; i += 1) {
    const file = files[i];
    const checksum = sha256(fs.readFileSync(path.join(dir, file), 'utf8'));
    await client.query(
      `INSERT INTO schema_migrations(id, checksum_sha256, application_version)
       VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [file, checksum, process.env.APP_VERSION || null]
    );
  }
}

async function resetPublicSchema(client) {
  if (!env.ALLOW_DESTRUCTIVE_MIGRATIONS) throw new Error('Destructive migrations are disabled. Set ALLOW_DESTRUCTIVE_MIGRATIONS=true to use --reset.');
  if (env.NODE_ENV === 'production') throw new Error('--reset is blocked in production environments.');
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
}

async function applyMigration(client, filename, rawSql) {
  if (/create\s+index\s+concurrently/i.test(rawSql)) {
    throw new Error(`${filename} uses CREATE INDEX CONCURRENTLY; split it into a separately managed online migration before applying`);
  }
  const sql = normalizeMigrationSql(rawSql);
  const checksum = sha256(rawSql);
  const started = Date.now();
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations(id, checksum_sha256, execution_ms, application_version)
       VALUES($1,$2,$3,$4)`,
      [filename, checksum, Date.now() - started, process.env.APP_VERSION || null]
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function createMigrationPool() {
  const connectionString = env.NODE_ENV === 'production' ? env.DATABASE_MIGRATOR_URL : (env.DATABASE_MIGRATOR_URL || env.DATABASE_URL);
  if (!connectionString) throw new Error('A migration database URL is required');
  return new Pool({
    connectionString,
    max: 2,
    ssl: env.PG_SSL ? { rejectUnauthorized: env.PG_SSL_REJECT_UNAUTHORIZED } : undefined,
  });
}

async function migrate() {
  validateRuntimeEnv();
  const args = parseArgs(process.argv);
  const migrationPool = createMigrationPool();
  const client = await migrationPool.connect();
  let locked = false;
  try {
    await acquireLock(client);
    locked = true;
    if (args.reset) {
      if (!args.forceReset) throw new Error('--reset requires --force-reset to avoid accidental data loss.');
      await resetPublicSchema(client);
    }

    await ensureSchemaMigrations(client);
    const files = readMigrationFiles(args.dir);
    if (args.baseline) await baselineUpTo(client, files, args.baseline, args.dir);

    let applied = await loadApplied(client);
    await verifyAndBackfillChecksums(client, files, args.dir, applied);
    applied = await loadApplied(client);
    const pending = files.filter((file) => !applied.has(file));

    if (args.dryRun) {
      console.log('Pending migrations:');
      for (const file of pending) console.log(' -', file);
      return;
    }

    for (const file of pending) {
      const rawSql = fs.readFileSync(path.join(args.dir, file), 'utf8');
      console.log('Applying', file);
      await applyMigration(client, file, rawSql);
    }
    console.log('Migrations complete.');
  } finally {
    if (locked) {
      try { await releaseLock(client); } catch (_) {}
    }
    client.release();
    await migrationPool.end();
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error('Migration failed:', error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = { migrate, normalizeMigrationSql, sha256 };
