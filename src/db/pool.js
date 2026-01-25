const { Pool } = require("pg");
const { env } = require("../config/env");

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: env.PG_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PG_POOL_CONNECTION_TIMEOUT_MS,
});

// Apply session-level safety settings on every new connection.
pool.on("connect", async (client) => {
  if (env.PG_STATEMENT_TIMEOUT_MS && env.PG_STATEMENT_TIMEOUT_MS > 0) {
    // Best-effort: do not crash app if SET fails for any reason.
    try {
      await client.query("SET statement_timeout = $1", [env.PG_STATEMENT_TIMEOUT_MS]);
    } catch (_) {
      // ignore
    }
  }
});

module.exports = { pool };
