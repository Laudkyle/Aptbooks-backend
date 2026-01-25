const { AppError } = require("../../shared/errors/AppError"); 
const { pool } = require("../../db/pool"); 

function assertDate(value, fieldName) {
  if (!value) throw new AppError(400, `${fieldName} is required`); 
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new AppError(400, `${fieldName} must be YYYY-MM-DD`); 
}

async function statementStatus({ orgId, fromDate, toDate, bankAccountId }) {
  assertDate(fromDate, "from"); 
  assertDate(toDate, "to"); 

  const params = [orgId, fromDate, toDate]; 
  let filter = ""; 
  if (bankAccountId) {
    params.push(bankAccountId); 
    filter = "AND bs.bank_account_id=$4"; 
  }

  const { rows } = await pool.query(
    `
    SELECT
      bs.id AS statement_id,
      ba.id AS bank_account_id,
      ba.code AS bank_account_code,
      ba.name AS bank_account_name,
      bs.statement_date,
      bs.opening_balance,
      bs.closing_balance,
      COUNT(bsl.id) AS line_count,
      SUM(CASE WHEN bsl.matched THEN 1 ELSE 0 END) AS matched_count,
      SUM(CASE WHEN NOT bsl.matched THEN 1 ELSE 0 END) AS unmatched_count,
      COALESCE(SUM(CASE WHEN bsl.matched THEN bsl.amount ELSE 0 END),0) AS matched_amount,
      COALESCE(SUM(CASE WHEN NOT bsl.matched THEN bsl.amount ELSE 0 END),0) AS unmatched_amount
    FROM bank_statements bs
    JOIN bank_accounts ba ON ba.id = bs.bank_account_id
    LEFT JOIN bank_statement_lines bsl ON bsl.statement_id = bs.id
    WHERE bs.organization_id=$1
      AND bs.statement_date BETWEEN $2::date AND $3::date
      ${filter}
    GROUP BY bs.id, ba.id
    ORDER BY ba.code, bs.statement_date
    `,
    params
  ); 

  return {
    from: fromDate,
    to: toDate,
    bank_account_id: bankAccountId || null,
    statements: rows.map((r) => ({
      statement_id: r.statement_id,
      bank_account: { id: r.bank_account_id, code: r.bank_account_code, name: r.bank_account_name },
      statement_date: r.statement_date,
      opening_balance: Number(r.opening_balance || 0),
      closing_balance: Number(r.closing_balance || 0),
      line_count: Number(r.line_count || 0),
      matched_count: Number(r.matched_count || 0),
      unmatched_count: Number(r.unmatched_count || 0),
      matched_amount: Number(r.matched_amount || 0),
      unmatched_amount: Number(r.unmatched_amount || 0)
    }))
  }; 
}

module.exports = { statementStatus }; 
