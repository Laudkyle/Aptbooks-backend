const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");
const { env } = require("../config/env");

const MIGRATIONS_DIR = path.join(__dirname, "migrations", "sql");

function parseArgs(argv) {
  const args = {
    dryRun: false,
    reset: false,
    forceReset: false,
    baseline: "",
    dir: MIGRATIONS_DIR,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--reset") args.reset = true;
    else if (a === "--force-reset") args.forceReset = true;
    else if (a === "--baseline") {
      args.baseline = argv[i + 1] || "";
      i++;
    } else if (a === "--dir") {
      args.dir = argv[i + 1] || args.dir;
      i++;
    }
  }
  return args;
}

async function acquireLock(client) {
  // Use a bigint advisory lock. MIGRATION_LOCK_ID is a string to avoid JS integer overflow.
  await client.query("SELECT pg_advisory_lock($1::bigint)", [env.MIGRATION_LOCK_ID]);
}

async function releaseLock(client) {
  await client.query("SELECT pg_advisory_unlock($1::bigint)", [env.MIGRATION_LOCK_ID]);
}

function readMigrationFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function containsNonTransactionalStatements(sql) {
  // Postgres doesn't allow CREATE INDEX CONCURRENTLY inside a transaction block.
  return /create\s+index\s+concurrently/i.test(sql);
}

async function ensureSchemaMigrations(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedSet(client) {
  const r = await client.query("SELECT id FROM schema_migrations");
  return new Set(r.rows.map((x) => x.id));
}

async function baselineUpTo(client, files, baselineFile) {
  if (!baselineFile) return;
  const idx = files.indexOf(baselineFile);
  if (idx === -1) {
    throw new Error(`Baseline file not found in migrations dir: ${baselineFile}`);
  }
  for (let i = 0; i <= idx; i++) {
    const f = files[i];
    await client.query("INSERT INTO schema_migrations(id) VALUES($1) ON CONFLICT DO NOTHING", [f]);
  }
}

async function resetPublicSchema(client) {
  if (!env.ALLOW_DESTRUCTIVE_MIGRATIONS) {
    throw new Error(
      "Destructive migrations are disabled. Set ALLOW_DESTRUCTIVE_MIGRATIONS=true to use --reset."
    );
  }
  if (env.NODE_ENV === "production") {
    throw new Error("--reset is blocked in production environments.");
  }
  console.log("⚠️  RESET: Dropping and recreating public schema (DEV ONLY)");
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
}

async function applyMigration(client, filename, sql) {
  const nonTx = containsNonTransactionalStatements(sql);
  if (!nonTx) {
    await client.query("BEGIN");
  }
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(id) VALUES($1)", [filename]);
    if (!nonTx) {
      await client.query("COMMIT");
    }
  } catch (e) {
    if (!nonTx) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        // ignore
      }
    }
    throw e;
  }
}

async function migrate() {
  const args = parseArgs(process.argv);
  const client = await pool.connect();
  try {
    await acquireLock(client);

    if (args.reset) {
      if (!args.forceReset) {
        throw new Error("--reset requires --force-reset to avoid accidental data loss.");
      }
      await resetPublicSchema(client);
    }

    await ensureSchemaMigrations(client);

    const files = readMigrationFiles(args.dir);
    if (args.baseline) {
      await baselineUpTo(client, files, args.baseline);
    }

    const applied = await getAppliedSet(client);
    const pending = files.filter((f) => !applied.has(f));

    if (args.dryRun) {
      console.log("Pending migrations:");
      for (const f of pending) console.log(" -", f);
      return;
    }

    for (const f of pending) {
      const sql = fs.readFileSync(path.join(args.dir, f), "utf8");
      console.log("Applying", f);
      await applyMigration(client, f, sql);
    }

    console.log("Migrations complete.");
  } finally {
    try {
      await releaseLock(client);
    } catch (_) {
      // ignore
    }
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrate().catch((e) => {
    console.error("Migration failed:", e?.message || e);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
