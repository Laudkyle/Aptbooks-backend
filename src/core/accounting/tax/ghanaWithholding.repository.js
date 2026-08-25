const { pool } = require('../../../db/pool');

async function listRemittances({ orgId, query = {}, client = null }) {
  const db = client || pool;
  const params = [orgId];
  const filters = ["organization_id=$1", "withholding_regime IN ('income_wht','vat_withholding')"];
  if (query.regime) { params.push(query.regime); filters.push(`withholding_regime=$${params.length}`); }
  if (query.status) { params.push(query.status); filters.push(`status=$${params.length}`); }
  if (query.fromDate) { params.push(query.fromDate); filters.push(`remittance_date >= $${params.length}::date`); }
  if (query.toDate) { params.push(query.toDate); filters.push(`remittance_date <= $${params.length}::date`); }
  const { rows } = await db.query(
    `SELECT id,organization_id,remittance_no,direction,status,period_start,period_end,remittance_date,
            currency_code,settlement_account_id,reference,memo,total_amount,withholding_regime,due_date,
            journal_entry_id,reversal_journal_entry_id,posted_at,voided_at,created_at,updated_at
       FROM withholding_remittances
      WHERE ${filters.join(' AND ')}
      ORDER BY remittance_date DESC,created_at DESC`,
    params,
  );
  return rows;
}

async function markReturnFiled({ orgId, returnId, actorUserId, graReference, client = null }) {
  const db = client || pool;
  const { rows } = await db.query(
    `UPDATE ghana_withholding_returns SET status='filed',gra_reference=$3,filed_at=NOW(),filed_by=$4,updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status IN ('finalized','amended') RETURNING *`,
    [orgId, returnId, graReference || null, actorUserId || null],
  );
  return rows[0] || null;
}

module.exports = { listRemittances, markReturnFiled };
