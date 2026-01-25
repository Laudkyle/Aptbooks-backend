const { AppError } = require("../../../shared/errors/AppError"); 
const { pool } = require("../../../db/pool"); 

async function listCashbook(orgId, query = {}) {
  const limit = Math.min(Number(query.limit || 200), 500); 
  const offset = Math.max(Number(query.offset || 0), 0); 
  const bankAccountId = query.bankAccountId || query.bank_account_id || null; 
  const dateFrom = query.dateFrom || query.date_from || null; 
  const dateTo = query.dateTo || query.date_to || null; 
  const includeRunning = String(query.includeRunningBalance || query.include_running_balance || "false").toLowerCase() === "true"; 

  if (bankAccountId) {
    const { rows } = await pool.query(
      `SELECT id FROM bank_accounts WHERE organization_id=$1 AND id=$2`,
      [orgId, bankAccountId]
    ); 
    if (!rows.length) throw new AppError(404, "Bank account not found"); 
  }


  const params = [orgId]; 
  let where = "WHERE bt.organization_id=$1"; 

  if (bankAccountId) {
    params.push(bankAccountId); 
    where += ` AND bt.bank_account_id=$${params.length}`; 
  }
  if (dateFrom) {
    params.push(dateFrom); 
    where += ` AND bt.txn_date >= $${params.length}`; 
  }
  if (dateTo) {
    params.push(dateTo); 
    where += ` AND bt.txn_date <= $${params.length}`; 
  }

  params.push(limit); 
  params.push(offset); 

  const runningExpr = includeRunning
    ? ", SUM(bt.amount) OVER (PARTITION BY bt.bank_account_id ORDER BY bt.txn_date, bt.created_at, bt.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance"
    : ""; 

  const { rows } = await pool.query(
    `
    SELECT
      bt.id,
      bt.bank_account_id,
      ba.code AS bank_account_code,
      ba.name AS bank_account_name,
      bt.txn_date,
      bt.amount,
      bt.description,
      bt.reference,
      bt.source_type,
      bt.source_id,
      bt.statement_line_id,
      bt.journal_entry_id,
      bt.external_id,
      bt.created_at,
      m.journal_entry_id AS matched_journal_entry_id,
      m.matched_at AS matched_at,
      m.matched_by AS matched_by
      ${runningExpr}
    FROM bank_transactions bt
    JOIN bank_accounts ba ON ba.id = bt.bank_account_id
    LEFT JOIN bank_matches m ON m.bank_statement_line_id = bt.statement_line_id
    ${where}
    ORDER BY bt.txn_date DESC, bt.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  ); 

  return { data: rows, paging: { limit, offset } }; 
}

module.exports = { listCashbook }; 
