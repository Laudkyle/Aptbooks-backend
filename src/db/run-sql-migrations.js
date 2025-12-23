const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

const DIR = path.join(__dirname, "migrations","sql");

(async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const files = fs.readdirSync(DIR).filter(f => f.endsWith(".sql")).sort();

    for (const f of files) {
      const exists = await client.query(
        `SELECT 1 FROM schema_migrations WHERE id=$1`,
        [f]
      );
      if (exists.rowCount) continue;

      console.log("Applying", f);
      const sql = fs.readFileSync(path.join(DIR, f), "utf8");

      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations(id) VALUES ($1)`, [f]);
      await client.query("COMMIT");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
})();
