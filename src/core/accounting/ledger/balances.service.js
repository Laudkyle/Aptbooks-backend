const { pool } = require("../../../db/pool");

async function trialBalance({ orgId, periodId }) {
  // Includes accounts with or without balances for the period.
  // Prefer general_ledger_balances, but safely fall back to posted journal lines.
  // This prevents financial statements from showing all zeros when the ledger
  // balance table has not been rebuilt after journals were posted.
  const { rows } = await pool.query(
    `
    WITH period_scope AS (
      SELECT id, start_date, end_date
      FROM accounting_periods
      WHERE organization_id = $1 AND id = $2
    ),
    posted_activity AS (
      SELECT
        jel.account_id,
        SUM(jel.debit) AS debit_total,
        SUM(jel.credit) AS credit_total
      FROM journal_entries je
      JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN period_scope p ON p.id = je.period_id
      WHERE je.organization_id = $1
        AND je.status = 'posted'
        AND je.entry_date BETWEEN p.start_date AND p.end_date
      GROUP BY jel.account_id
    ),
    merged AS (
      SELECT
        coa.id AS account_id,
        COALESCE(glb.debit_total, pa.debit_total, 0) AS debit_total,
        COALESCE(glb.credit_total, pa.credit_total, 0) AS credit_total
      FROM chart_of_accounts coa
      LEFT JOIN general_ledger_balances glb
        ON glb.organization_id = coa.organization_id
       AND glb.account_id = coa.id
       AND glb.period_id = $2
      LEFT JOIN posted_activity pa ON pa.account_id = coa.id
      WHERE coa.organization_id = $1
    )
    SELECT
      coa.id AS account_id,
      coa.code,
      coa.name,
      at.code AS account_type,
      at.normal_balance,
      COALESCE(m.debit_total, 0) AS debit_total,
      COALESCE(m.credit_total, 0) AS credit_total,
      (COALESCE(m.debit_total,0) - COALESCE(m.credit_total,0)) AS net_debit_minus_credit
    FROM chart_of_accounts coa
    JOIN account_types at ON at.id = coa.account_type_id
    LEFT JOIN merged m ON m.account_id = coa.id
    WHERE coa.organization_id = $1
    ORDER BY coa.code
    `,
    [orgId, periodId]
  );
  return rows;
}

async function glBalances({ orgId, periodId }) {
  const { rows } = await pool.query(
    `
    SELECT coa.code, coa.name, glb.debit_total, glb.credit_total
    FROM general_ledger_balances glb
    JOIN chart_of_accounts coa
      ON coa.id = glb.account_id AND coa.organization_id = glb.organization_id
    WHERE glb.organization_id=$1 AND glb.period_id=$2
    ORDER BY coa.code
    `,
    [orgId, periodId]
  );
  return rows;
}

async function accountActivity({ orgId, accountId, fromDate, toDate }) {
  const { rows } = await pool.query(
    `
    SELECT
      je.id AS journal_id,
      je.entry_no,
      je.entry_date,
      je.status,
      jel.line_no,
      jel.description,
      jel.debit,
      jel.credit,
      jel.currency_code,
      jel.fx_rate,
      jel.amount_base
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id=$1
      AND jel.account_id=$2
      AND je.entry_date >= $3 AND je.entry_date <= $4
      AND je.status IN ('posted','voided')
    ORDER BY je.entry_date, je.entry_no, jel.line_no
    `,
    [orgId, accountId, fromDate, toDate]
  );
  return rows;
}

module.exports = { trialBalance, glBalances, accountActivity };
