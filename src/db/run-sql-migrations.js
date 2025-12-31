const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

const DIR = path.join(__dirname, "migrations", "sql");

(async () => {
  const client = await pool.connect();
  try {
    // First, clear the entire database (DANGER: deletes all data!)
    console.log("⚠️  WARNING: This will delete ALL data in the database!");
    
    // For automated scripts, you might want to add a confirmation flag
    // For now, we'll proceed with a simple prompt simulation
    // In production, you might want to use command-line arguments
    
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    
    // Grant default privileges (optional, but good practice)
    await client.query("GRANT ALL ON SCHEMA public TO postgres");
    await client.query("GRANT ALL ON SCHEMA public TO public");

    // Now create the migrations table and run migrations
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