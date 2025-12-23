const { pool } = require("../db/pool");

async function listPaymentTerms({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_terms WHERE organization_id=$1 ORDER BY is_default DESC, name ASC`,
    [orgId]
  );
  return rows;
}

async function listPaymentMethods({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_methods WHERE organization_id=$1 ORDER BY name ASC`,
    [orgId]
  );
  return rows;
}

module.exports = { listPaymentTerms, listPaymentMethods };
