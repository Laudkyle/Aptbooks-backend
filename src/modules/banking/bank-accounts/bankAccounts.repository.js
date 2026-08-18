const { pool } = require("../../../db/pool");

async function create(orgId, payload) {
  const { code, name, currencyCode, glAccountId, isActive } = payload;
  const { rows } = await pool.query(
    `INSERT INTO bank_accounts(organization_id, code, name, currency_code, gl_account_id, is_active)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [orgId, code, name, currencyCode, glAccountId, isActive !== false]
  );
  return rows[0];
}

async function list(orgId) {
  const { rows } = await pool.query(
    `SELECT ba.*, coa.code AS gl_account_code, coa.name AS gl_account_name
       FROM bank_accounts ba
       LEFT JOIN chart_of_accounts coa ON coa.id=ba.gl_account_id AND coa.organization_id=ba.organization_id
      WHERE ba.organization_id=$1 ORDER BY ba.code`,
    [orgId]
  );
  return rows;
}

module.exports = { create, list };
