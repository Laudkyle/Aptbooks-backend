const { pool } = require("./pool");

/**
 * Execute a function inside a DB transaction.
 *
 * If an existing client is provided, the function executes using that client
 * without beginning/committing a nested transaction.
 */
async function withTransaction(fn, existingClient = null) {
  if (existingClient) return fn(existingClient);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
