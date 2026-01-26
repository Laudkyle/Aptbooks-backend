const { pool } = require("../../../db/pool");

/**
 * Currencies are global reference data (not organization-scoped).
 * Table: currencies(code CHAR(3) PRIMARY KEY, name TEXT NOT NULL)
 */
async function listCurrencies({ q, limit } = {}) {
  const safeLimit = Math.min(Number.parseInt(String(limit || "500"), 10) || 500, 1000);
  const query = (q || "").toString().trim();

  if (!query) {
    const { rows } = await pool.query(
      `
      SELECT code, name
      FROM currencies
      ORDER BY code
      LIMIT $1
      `,
      [safeLimit]
    );
    return rows;
  }

  // Optional search by code or name
  const { rows } = await pool.query(
    `
    SELECT code, name
    FROM currencies
    WHERE code ILIKE ($1 || '%')
       OR name ILIKE ('%' || $1 || '%')
    ORDER BY code
    LIMIT $2
    `,
    [query, safeLimit]
  );
  return rows;
}

module.exports = {
  listCurrencies,
};
