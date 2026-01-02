const { pool } = require("../../../db/pool");

async function create(orgId, userId, { bankAccountId, periodId }) {
  const { rows } = await pool.query(
    `INSERT INTO bank_reconciliations(organization_id, bank_account_id, period_id, reconciled_by)
     VALUES($1,$2,$3,$4)
     RETURNING *`,
    [orgId, bankAccountId, periodId, userId || null]
  );
  return rows[0];
}

module.exports = { create };
