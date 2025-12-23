const { pool } = require("../../../db/pool");

async function trialBalance({ orgId, periodId }) {
  // Includes accounts with or without balances for the period
  const { rows } = await pool.query(
    `
    SELECT
      coa.id AS account_id,
      coa.code,
      coa.name,
      at.code AS account_type,
      at.normal_balance,
      COALESCE(glb.debit_total, 0) AS debit_total,
      COALESCE(glb.credit_total, 0) AS credit_total,
      (COALESCE(glb.debit_total,0) - COALESCE(glb.credit_total,0)) AS net_debit_minus_credit
    FROM chart_of_accounts coa
    JOIN account_types at ON at.id = coa.account_type_id
    LEFT JOIN general_ledger_balances glb
      ON glb.organization_id = coa.organization_id
     AND glb.account_id = coa.id
     AND glb.period_id = $2
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
      jel.credit
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
