
const { pool } = require("../../../../db/pool");

async function list(orgId, filters = {}) {
  const params = [orgId];
  const where = ["pr.organization_id=$1"];
  if (filters.status) { params.push(filters.status); where.push(`pr.status=$${params.length}`); }
  if (filters.bankAccountId) { params.push(filters.bankAccountId); where.push(`pr.bank_account_id=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT pr.*, ba.code AS bank_account_code, ba.name AS bank_account_name,
            COALESCE((SELECT SUM(prl.amount) FROM payment_run_lines prl WHERE prl.payment_run_id = pr.id), 0) AS total_amount,
            COALESCE((SELECT COUNT(*) FROM payment_run_lines prl WHERE prl.payment_run_id = pr.id), 0) AS line_count
       FROM payment_runs pr
       JOIN bank_accounts ba ON ba.id = pr.bank_account_id
      WHERE ${where.join(' AND ')}
      ORDER BY pr.created_at DESC`,
    params
  );
  return rows;
}

async function get(orgId, paymentRunId, client = pool) {
  const { rows } = await client.query(
    `SELECT pr.*, ba.code AS bank_account_code, ba.name AS bank_account_name,
            COALESCE((SELECT SUM(prl.amount) FROM payment_run_lines prl WHERE prl.payment_run_id = pr.id), 0) AS total_amount
       FROM payment_runs pr
       JOIN bank_accounts ba ON ba.id = pr.bank_account_id
      WHERE pr.organization_id=$1 AND pr.id=$2`,
    [orgId, paymentRunId]
  );
  return rows[0] || null;
}

async function getLines(orgId, paymentRunId, client = pool) {
  const { rows } = await client.query(
    `SELECT prl.*, bp.name AS partner_name, coa.code AS offset_account_code, coa.name AS offset_account_name
       FROM payment_run_lines prl
       LEFT JOIN business_partners bp ON bp.id = prl.partner_id
       LEFT JOIN chart_of_accounts coa ON coa.id = prl.offset_account_id
      WHERE prl.organization_id=$1 AND prl.payment_run_id=$2
      ORDER BY prl.line_no ASC, prl.created_at ASC`,
    [orgId, paymentRunId]
  );
  return rows;
}

async function create(orgId, payload, actorUserId, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO payment_runs(
      organization_id, code, bank_account_id, execution_date, currency_code, memo,
      status, created_by_user_id
    ) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)
    RETURNING *`,
    [orgId, payload.code, payload.bankAccountId, payload.executionDate, payload.currencyCode, payload.memo || null, actorUserId || null]
  );
  return rows[0];
}

async function addLines(orgId, paymentRunId, lines, client = pool) {
  const inserted = [];
  for (const l of lines) {
    const { rows } = await client.query(
      `INSERT INTO payment_run_lines(
        organization_id, payment_run_id, line_no, partner_id, payee_name, source_type, source_id,
        offset_account_id, description, amount, currency_code, dimensions_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
      [
        orgId,
        paymentRunId,
        l.lineNo,
        l.partnerId || null,
        l.payeeName || null,
        l.sourceType || null,
        l.sourceId || null,
        l.offsetAccountId,
        l.description || null,
        l.amount,
        l.currencyCode || null,
        JSON.stringify(l.dimensionsJson || {})
      ]
    );
    inserted.push(rows[0]);
  }
  return inserted;
}

async function replaceStatus(orgId, paymentRunId, status, patch = {}, client = pool) {
  const fields = [
    ['status', status],
    ['period_id', patch.periodId],
    ['journal_entry_id', patch.journalEntryId],
    ['approval_batch_id', patch.approvalBatchId],
    ['approved_by_user_id', patch.approvedByUserId],
    ['executed_by_user_id', patch.executedByUserId],
    ['cancelled_reason', patch.cancelledReason]
  ];
  const sets = [];
  const params = [orgId, paymentRunId];
  for (const [col, val] of fields) {
    if (val !== undefined) {
      params.push(val);
      sets.push(`${col}=$${params.length}`);
    }
  }
  sets.push('updated_at=NOW()');
  const { rows } = await client.query(
    `UPDATE payment_runs SET ${sets.join(', ')} WHERE organization_id=$1 AND id=$2 RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function lockHeader(orgId, paymentRunId, client = pool) {
  const { rows } = await client.query(
    `SELECT id FROM payment_runs WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
    [orgId, paymentRunId]
  );
  return rows[0] || null;
}

async function getNextLineNo(orgId, paymentRunId, client = pool) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(line_no), 0) + 1 AS next_line_no
       FROM payment_run_lines
      WHERE organization_id=$1 AND payment_run_id=$2`,
    [orgId, paymentRunId]
  );
  return Number(rows[0]?.next_line_no || 1);
}

module.exports = { list, get, getLines, create, addLines, replaceStatus, lockHeader, getNextLineNo };
