const { Pool } = require('pg');
const { env } = require('../config/env');
const { getTenantId, normalizeTenantId } = require('../shared/security/tenantContext');
const { metrics } = require('../observability/metrics.registry');
const logger = require('../config/logger');

const rawPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: env.PG_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PG_POOL_CONNECTION_TIMEOUT_MS,
  ssl: env.PG_SSL ? { rejectUnauthorized: env.PG_SSL_REJECT_UNAUTHORIZED } : undefined,
});

const rawConnect = rawPool.connect.bind(rawPool);
const rawEnd = rawPool.end.bind(rawPool);

async function setClientTenant(client, organizationId, { local = false } = {}) {
  if (!env.RLS_ENABLED) return;
  const tenantId = organizationId ? normalizeTenantId(organizationId) : '';
  await client.query(`SELECT set_config('app.current_organization_id', $1, $2)`, [tenantId, Boolean(local)]);
}

async function clearClientTenant(client) {
  if (!env.RLS_ENABLED) return;
  try {
    await client.query(`SELECT set_config('app.current_organization_id', '', false)`);
  } catch (_) {
    // If the connection is already broken there is nothing safe to reuse.
  }
}

async function configureCheckout(client) {
  if (env.PG_STATEMENT_TIMEOUT_MS > 0) {
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [String(env.PG_STATEMENT_TIMEOUT_MS)]);
  }
  await setClientTenant(client, getTenantId(), { local: false });
}

function decorateRelease(client) {
  // pg-pool installs a fresh release function for every checkout, even when it
  // reuses the same physical Client object. Capture that checkout-local
  // function every time; never cache it on the Client across pool checkouts.
  const originalRelease = client.release.bind(client);
  let released = false;
  client.release = (error) => {
    if (released) return;
    released = true;

    // Never return a connection to the pool until tenant state is scrubbed.
    // Restore the pool-provided release function before handing the client
    // back so no AptBooks wrapper survives into a later checkout.
    void clearClientTenant(client)
      .then(() => {
        client.release = originalRelease;
        originalRelease(error);
      })
      .catch((releaseError) => {
        client.release = originalRelease;
        logger.error({ err: releaseError }, 'Failed to scrub tenant state before releasing database client');
        // Release with an error so pg-pool discards the connection instead of
        // allowing a potentially dirty session to be reused.
        originalRelease(releaseError);
      });
  };
  return client;
}

async function connect() {
  const client = await rawConnect();
  try {
    await configureCheckout(client);
    return decorateRelease(client);
  } catch (error) {
    try { await clearClientTenant(client); } catch (_) {}
    client.release(error);
    throw error;
  }
}

async function query(text, params, callback) {
  const startNs = process.hrtime.bigint();
  const operation = String(text || '').trim().split(/\s+/, 1)[0]?.toUpperCase() || 'UNKNOWN';
  // Use an explicitly checked-out client so every one-off query gets a tenant
  // context and that context is scrubbed before the connection is reused.
  const client = await rawConnect();
  try {
    await configureCheckout(client);
    if (typeof callback === 'function') {
      return await new Promise((resolve, reject) => {
        client.query(text, params, async (error, result) => {
          const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
          metrics.dbDuration.observe({ operation }, seconds);
          if (error) metrics.dbErrors.inc({ operation });
          if (seconds * 1000 >= env.SLOW_DB_QUERY_MS) logger.warn({ operation, durationMs: Math.round(seconds * 1000) }, 'Slow database query');
          try { await clearClientTenant(client); } finally { client.release(error); }
          try { callback(error, result); } catch (callbackError) { reject(callbackError); return; }
          if (error) reject(error); else resolve(result);
        });
      });
    }
    const result = await client.query(text, params);
    const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    metrics.dbDuration.observe({ operation }, seconds);
    if (seconds * 1000 >= env.SLOW_DB_QUERY_MS) logger.warn({ operation, durationMs: Math.round(seconds * 1000) }, 'Slow database query');
    await clearClientTenant(client);
    client.release();
    return result;
  } catch (error) {
    metrics.dbErrors.inc({ operation });
    const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    metrics.dbDuration.observe({ operation }, seconds);
    await clearClientTenant(client);
    client.release(error);
    throw error;
  }
}

async function assertRuntimeRoleSafe() {
  const client = await rawConnect();
  try {
    const { rows } = await client.query(`
      SELECT r.rolname,
             r.rolsuper,
             r.rolcreaterole,
             r.rolcreatedb,
             r.rolreplication,
             r.rolbypassrls,
             EXISTS (
               SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public'
                 AND c.relkind IN ('r','p')
                 AND pg_get_userbyid(c.relowner)=current_user
             ) AS owns_public_tables
      FROM pg_roles r
      WHERE r.rolname=current_user
    `);
    const role = rows[0];
    if (!role) throw new Error('Could not inspect database runtime role');
    const unsafe = role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls || role.owns_public_tables;
    if (unsafe) {
      throw new Error(`Runtime database role ${role.rolname} is over-privileged; it must not be superuser, BYPASSRLS, DDL-capable, or own application tables`);
    }
    return role;
  } finally {
    client.release();
  }
}

// Keep the normal Pool surface used throughout the application while making
// query/connect tenant-aware.
rawPool.query = query;
rawPool.connect = connect;
rawPool.end = rawEnd;

module.exports = { pool: rawPool, setClientTenant, clearClientTenant, assertRuntimeRoleSafe };
