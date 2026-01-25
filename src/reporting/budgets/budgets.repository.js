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

async function updateVersionWorkflow({ orgId, budgetId, versionId, patch }) {
  const {
    workflowStatus,
    submittedAt,
    submittedByUserId,
    approvedAt,
    approvedByUserId,
    rejectedAt,
    rejectedByUserId,
    rejectionReason,
    scenarioKey,
    templateSourceVersionId,
  } = patch || {}; 

  const { rows } = await pool.query(
    `
    UPDATE budget_versions
    SET workflow_status = COALESCE($4, workflow_status),
        submitted_at = COALESCE($5, submitted_at),
        submitted_by_user_id = COALESCE($6, submitted_by_user_id),
        approved_at = COALESCE($7, approved_at),
        approved_by_user_id = COALESCE($8, approved_by_user_id),
        rejected_at = COALESCE($9, rejected_at),
        rejected_by_user_id = COALESCE($10, rejected_by_user_id),
        rejection_reason = COALESCE($11, rejection_reason),
        scenario_key = COALESCE($12, scenario_key),
        template_source_version_id = COALESCE($13, template_source_version_id),
        updated_at = NOW()
    WHERE organization_id = $1 AND budget_id = $2 AND id = $3
    RETURNING *
    `,
    [
      orgId,
      budgetId,
      versionId,
      workflowStatus || null,
      submittedAt || null,
      submittedByUserId || null,
      approvedAt || null,
      approvedByUserId || null,
      rejectedAt || null,
      rejectedByUserId || null,
      rejectionReason || null,
      scenarioKey || null,
      templateSourceVersionId || null,
    ]
  ); 
  return rows[0] || null; 
}

async function copyVersion({ orgId, budgetId, sourceVersionId, newVersionNo, name, scenarioKey, createdByUserId }) {
  // Create new version
  const { rows: vrows } = await pool.query(
    `
    INSERT INTO budget_versions(organization_id, budget_id, version_no, name, status, created_by_user_id, workflow_status, scenario_key, template_source_version_id)
    SELECT organization_id, budget_id, $4, COALESCE($5, name), 'draft', $6, 'draft', COALESCE($7, scenario_key), $3
    FROM budget_versions
    WHERE organization_id=$1 AND budget_id=$2 AND id=$3
    RETURNING *
    `,
    [orgId, budgetId, sourceVersionId, newVersionNo, name || null, createdByUserId || null, scenarioKey || null]
  ); 
  const created = vrows[0]; 
  if (!created) return null; 

  // Copy lines
  await pool.query(
    `
    INSERT INTO budget_lines(organization_id, budget_version_id, account_id, period_id, amount, dimension_json)
    SELECT organization_id, $2, account_id, period_id, amount, dimension_json
    FROM budget_lines
    WHERE organization_id=$1 AND budget_version_id=$3
    `,
    [orgId, created.id, sourceVersionId]
  ); 

  return created; 
}

async function massAdjustLines({ orgId, versionId, pct, accountId, periodId, dimensionJson }) {
  const multiplier = 1 + Number(pct) / 100; 
  if (!Number.isFinite(multiplier)) throw new Error("Invalid pct"); 

  const params = [orgId, versionId, multiplier]; 
  let where = "WHERE organization_id=$1 AND budget_version_id=$2"; 
  let idx = 4; 
  if (accountId) {
    params.push(accountId); 
    where += ` AND account_id=$${idx++}`; 
  }
  if (periodId) {
    params.push(periodId); 
    where += ` AND period_id=$${idx++}`; 
  }
  if (dimensionJson) {
    params.push(JSON.stringify(dimensionJson)); 
    where += ` AND dimension_json @> $${idx++}::jsonb`; 
  }
  const { rowCount } = await pool.query(
    `
    UPDATE budget_lines
    SET amount = ROUND((amount * $3)::numeric, 2),
        updated_at = NOW()
    ${where}
    `,
    params
  ); 
  return { affected: rowCount }; 
}

async function listAlertRules({ orgId, budgetId }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM budget_alert_rules
    WHERE organization_id=$1 AND budget_id=$2
    ORDER BY created_at DESC
    `,
    [orgId, budgetId]
  ); 
  return rows; 
}

async function createAlertRule({ orgId, budgetId, name, thresholdPct, accountId, dimensionJson, isEnabled }) {
  const { rows } = await pool.query(
    `
    INSERT INTO budget_alert_rules(organization_id, budget_id, name, threshold_pct, account_id, dimension_json, is_enabled)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *
    `,
    [orgId, budgetId, name, thresholdPct, accountId || null, dimensionJson || {}, isEnabled === undefined ? true : !!isEnabled]
  ); 
  return rows[0]; 
}

async function getAlertRule({ orgId, budgetId, ruleId }) {
  const { rows } = await pool.query(
    `SELECT * FROM budget_alert_rules WHERE organization_id=$1 AND budget_id=$2 AND id=$3 LIMIT 1`,
    [orgId, budgetId, ruleId]
  ); 
  return rows[0] || null; 
}

async function updateAlertRule({ orgId, budgetId, ruleId, patch }) {
  const { name, thresholdPct, accountId, dimensionJson, isEnabled } = patch || {}; 
  const { rows } = await pool.query(
    `
    UPDATE budget_alert_rules
    SET name = COALESCE($4, name),
        threshold_pct = COALESCE($5, threshold_pct),
        account_id = COALESCE($6, account_id),
        dimension_json = COALESCE($7, dimension_json),
        is_enabled = COALESCE($8, is_enabled),
        updated_at = NOW()
    WHERE organization_id=$1 AND budget_id=$2 AND id=$3
    RETURNING *
    `,
    [
      orgId,
      budgetId,
      ruleId,
      name || null,
      thresholdPct === undefined ? null : thresholdPct,
      accountId === undefined ? null : accountId,
      dimensionJson === undefined ? null : dimensionJson,
      isEnabled === undefined ? null : !!isEnabled,
    ]
  ); 
  return rows[0] || null; 
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
  updateVersionWorkflow,
  copyVersion,
  massAdjustLines,
  listAlertRules,
  createAlertRule,
  getAlertRule,
  updateAlertRule,
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
