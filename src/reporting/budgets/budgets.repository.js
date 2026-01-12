const { pool } = require("../../db/pool");

async function listBudgets({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT id, name, fiscal_year, currency_code, status, created_at, updated_at
    FROM budgets
    WHERE organization_id=$1
    ORDER BY created_at DESC
    `,
    [orgId]
  );
  return rows;
}

async function createBudget({ orgId, name, fiscalYear, currencyCode, status }) {
  const { rows } = await pool.query(
    `
    INSERT INTO budgets(organization_id, name, fiscal_year, currency_code, status)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id, name, fiscal_year, currency_code, status, created_at, updated_at
    `,
    [orgId, name, fiscalYear || null, currencyCode, status || "draft"]
  );
  return rows[0];
}

async function getBudget({ orgId, id }) {
  const { rows } = await pool.query(
    `SELECT * FROM budgets WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, id]
  );
  return rows.length ? rows[0] : null;
}

async function updateBudget({ orgId, id, name, fiscalYear, currencyCode, status }) {
  const { rows } = await pool.query(
    `
    UPDATE budgets
    SET name = COALESCE($3, name),
        fiscal_year = COALESCE($4, fiscal_year),
        currency_code = COALESCE($5, currency_code),
        status = COALESCE($6, status),
        updated_at = NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING id, name, fiscal_year, currency_code, status, created_at, updated_at
    `,
    [orgId, id, name || null, fiscalYear || null, currencyCode || null, status || null]
  );
  return rows.length ? rows[0] : null;
}

async function createVersion({ orgId, budgetId, versionNo, name, status, createdByUserId }) {
  const { rows } = await pool.query(
    `
    INSERT INTO budget_versions(organization_id, budget_id, version_no, name, status, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id, budget_id, version_no, name, status, created_at
    `,
    [orgId, budgetId, versionNo, name || null, status || "draft", createdByUserId || null]
  );
  return rows[0];
}

async function getVersion({ orgId, budgetId, versionId }) {
  const { rows } = await pool.query(
    `
    SELECT * FROM budget_versions
    WHERE organization_id=$1 AND budget_id=$2 AND id=$3
    LIMIT 1
    `,
    [orgId, budgetId, versionId]
  );
  return rows.length ? rows[0] : null;
}

async function upsertLine({ orgId, versionId, accountId, periodId, amount, dimensionJson }) {
  const { rows } = await pool.query(
    `
    INSERT INTO budget_lines(
      organization_id, budget_version_id, account_id, period_id, amount, dimension_json
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (budget_version_id, account_id, period_id)
    DO UPDATE SET amount = EXCLUDED.amount,
                  dimension_json = EXCLUDED.dimension_json,
                  updated_at = NOW()
    RETURNING id, account_id, period_id, amount, dimension_json, created_at, updated_at
    `,
    [orgId, versionId, accountId, periodId || null, amount, dimensionJson || {}]
  );
  return rows[0];
}


async function getAccountingPeriod({ orgId, periodId }) {
  const { rows } = await pool.query(
    `SELECT id, organization_id, start_date, end_date, status FROM accounting_periods WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, periodId]
  );
  return rows.length ? rows[0] : null;
}

async function listPeriodsByStartYear({ orgId, year }) {
  const { rows } = await pool.query(
    `
    SELECT id, start_date, end_date, code, status
    FROM accounting_periods
    WHERE organization_id=$1
      AND EXTRACT(YEAR FROM start_date) = $2
    ORDER BY start_date ASC
    `,
    [orgId, year]
  );
  return rows;
}

module.exports = {
  listBudgets,
  createBudget,
  getBudget,
  updateBudget,
  createVersion,
  getVersion,
  upsertLine,
  getVariance,
  getAccountingPeriod,
  listPeriodsByStartYear,
};

// Variance: Budget vs Actual (uses GL balances for speed/consistency)
async function getVariance({ orgId, budgetVersionId, periodId }) {
  const { rows } = await pool.query(
    `
    WITH budget AS (
      SELECT bl.account_id,
             SUM(bl.amount) AS budget_amount
      FROM budget_lines bl
      JOIN budget_versions bv ON bv.id = bl.budget_version_id
      WHERE bl.organization_id = $1
        AND bl.budget_version_id = $2
        AND bl.period_id = $3
      GROUP BY bl.account_id
    ), actual AS (
      SELECT gl.account_id,
             gl.debit_total,
             gl.credit_total,
             (gl.debit_total - gl.credit_total) AS actual_net
      FROM general_ledger_balances gl
      WHERE gl.organization_id = $1
        AND gl.period_id = $3
    )
    SELECT b.account_id,
           coa.code AS account_code,
           coa.name AS account_name,
           at.normal_balance AS normal_balance,
           b.budget_amount,
           COALESCE(a.debit_total, 0) AS actual_debit_total,
           COALESCE(a.credit_total, 0) AS actual_credit_total,
           COALESCE(a.actual_net, 0) AS actual_net,
           CASE
             WHEN at.normal_balance = 'credit' THEN -COALESCE(a.actual_net, 0)
             ELSE COALESCE(a.actual_net, 0)
           END AS actual_normalized,
           (
             CASE
               WHEN at.normal_balance = 'credit' THEN -COALESCE(a.actual_net, 0)
               ELSE COALESCE(a.actual_net, 0)
             END
             - b.budget_amount
           ) AS variance
    FROM budget b
    JOIN chart_of_accounts coa ON coa.id = b.account_id
    JOIN account_types at ON at.id = coa.account_type_id
    LEFT JOIN actual a ON a.account_id = b.account_id
    ORDER BY coa.code
    `,
    [orgId, budgetVersionId, periodId]
  );
  return rows;
}
