
const { pool } = require('../../../../db/pool');

async function list(orgId, filters = {}) {
  const params = [orgId];
  const where = ['bt.organization_id=$1'];
  if (filters.status) { params.push(filters.status); where.push(`bt.status=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT bt.*, fba.code AS from_bank_code, fba.name AS from_bank_name, tba.code AS to_bank_code, tba.name AS to_bank_name
       FROM bank_transfers bt
       JOIN bank_accounts fba ON fba.id = bt.from_bank_account_id
       JOIN bank_accounts tba ON tba.id = bt.to_bank_account_id
      WHERE ${where.join(' AND ')}
      ORDER BY bt.created_at DESC`,
    params
  );
  return rows;
}

async function get(orgId, bankTransferId, client = pool) {
  const { rows } = await client.query(
    `SELECT bt.*, fba.code AS from_bank_code, fba.name AS from_bank_name, tba.code AS to_bank_code, tba.name AS to_bank_name
       FROM bank_transfers bt
       JOIN bank_accounts fba ON fba.id = bt.from_bank_account_id
       JOIN bank_accounts tba ON tba.id = bt.to_bank_account_id
      WHERE bt.organization_id=$1 AND bt.id=$2`,
    [orgId, bankTransferId]
  );
  return rows[0] || null;
}

async function create(orgId, payload, actorUserId, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO bank_transfers(
      organization_id, code, from_bank_account_id, to_bank_account_id, transfer_date, amount,
      fee_amount, fee_account_id, reference, memo, status, created_by_user_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11)
    RETURNING *`,
    [orgId, payload.code, payload.fromBankAccountId, payload.toBankAccountId, payload.transferDate, payload.amount, payload.feeAmount, payload.feeAccountId || null, payload.reference || null, payload.memo || null, actorUserId || null]
  );
  return rows[0];
}

async function updateStatus(orgId, bankTransferId, status, patch = {}, client = pool) {
  const fields = [
    ['status', status],
    ['period_id', patch.periodId],
    ['journal_entry_id', patch.journalEntryId],
    ['approval_batch_id', patch.approvalBatchId],
    ['approved_by_user_id', patch.approvedByUserId],
    ['posted_by_user_id', patch.postedByUserId],
    ['cancelled_reason', patch.cancelledReason]
  ];
  const params = [orgId, bankTransferId];
  const sets = [];
  for (const [col, val] of fields) {
    if (val !== undefined) {
      params.push(val);
      sets.push(`${col}=$${params.length}`);
    }
  }
  sets.push('updated_at=NOW()');
  const { rows } = await client.query(`UPDATE bank_transfers SET ${sets.join(', ')} WHERE organization_id=$1 AND id=$2 RETURNING *`, params);
  return rows[0] || null;
}

module.exports = { list, get, create, updateStatus };
