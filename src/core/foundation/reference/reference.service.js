const { pool } = require("../../../db/pool");

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
