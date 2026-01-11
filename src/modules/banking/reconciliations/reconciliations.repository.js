const { pool } = require("../../../db/pool");

function db(client) { return client || pool; }

async function findActive(orgId, bankAccountId, periodId, client = null) {
  const { rows } = await db(client).query(
    `SELECT * FROM bank_reconciliations
     WHERE organization_id=$1 AND bank_account_id=$2 AND period_id=$3 AND status='reconciled'
     ORDER BY reconciled_at DESC
     LIMIT 1`,
    [orgId, bankAccountId, periodId]
  );
  return rows[0] || null;
}

async function create(orgId, userId, { bankAccountId, periodId }, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO bank_reconciliations(organization_id, bank_account_id, period_id, reconciled_by)
     VALUES($1,$2,$3,$4)
     RETURNING *`,
    [orgId, bankAccountId, periodId, userId || null]
  );
  return rows[0];
}

module.exports = { create, findActive };
