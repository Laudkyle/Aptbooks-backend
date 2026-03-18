
const { pool } = require('../../../../db/pool');

async function list(orgId, filters = {}) {
  const params = [orgId];
  const where = ['c.organization_id=$1'];
  if (filters.status) { params.push(filters.status); where.push(`c.status=$${params.length}`); }
  if (filters.bankAccountId) { params.push(filters.bankAccountId); where.push(`c.bank_account_id=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT c.*, ba.code AS bank_account_code, ba.name AS bank_account_name
       FROM cheques c
       JOIN bank_accounts ba ON ba.id = c.bank_account_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.created_at DESC`,
    params
  );
  return rows;
}

async function get(orgId, chequeId, client = pool) {
  const { rows } = await client.query(
    `SELECT c.*, ba.code AS bank_account_code, ba.name AS bank_account_name
       FROM cheques c
       JOIN bank_accounts ba ON ba.id = c.bank_account_id
      WHERE c.organization_id=$1 AND c.id=$2`,
    [orgId, chequeId]
  );
  return rows[0] || null;
}

async function create(orgId, payload, actorUserId, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO cheques(
      organization_id, bank_account_id, cheque_no, payee_name, issue_date, amount,
      currency_code, status, memo, created_by_user_id, payment_run_id, journal_entry_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *`,
    [orgId, payload.bankAccountId, payload.chequeNo, payload.payeeName || null, payload.issueDate || null, payload.amount || null, payload.currencyCode || null, payload.status, payload.memo || null, actorUserId || null, payload.paymentRunId || null, payload.journalEntryId || null]
  );
  return rows[0];
}

async function update(orgId, chequeId, patch = {}, client = pool) {
  const params = [orgId, chequeId, patch.status ?? null, patch.clearedDate ?? null, patch.journalEntryId ?? null, patch.memo ?? null, patch.paymentRunId ?? null];
  const { rows } = await client.query(
    `UPDATE cheques
        SET status=COALESCE($3,status),
            cleared_date=COALESCE($4,cleared_date),
            journal_entry_id=COALESCE($5,journal_entry_id),
            memo=COALESCE($6,memo),
            payment_run_id=COALESCE($7,payment_run_id),
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    params
  );
  return rows[0] || null;
}

module.exports = { list, get, create, update };
