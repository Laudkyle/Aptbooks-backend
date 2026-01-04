const { pool } = require("../../db/pool");

async function listForecasts({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT id, name, currency_code, status, created_at, updated_at
    FROM forecasts
    WHERE organization_id=$1
    ORDER BY created_at DESC
    `,
    [orgId]
  );
  return rows;
}

async function createForecast({ orgId, name, currencyCode, status, createdByUserId }) {
  const { rows } = await pool.query(
    `
    INSERT INTO forecasts(organization_id, name, currency_code, status, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id, name, currency_code, status, created_at, updated_at
    `,
    [orgId, name, currencyCode, status || "active", createdByUserId || null]
  );
  return rows[0];
}

async function getForecast({ orgId, id }) {
  const { rows } = await pool.query(
    `SELECT * FROM forecasts WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, id]
  );
  return rows.length ? rows[0] : null;
}

async function upsertLine({ orgId, forecastId, accountId, periodId, amount, dimensionJson }) {
  const { rows } = await pool.query(
    `
    INSERT INTO forecast_lines(organization_id, forecast_id, account_id, period_id, amount, dimension_json)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (forecast_id, account_id, period_id)
    DO UPDATE SET amount=EXCLUDED.amount,
                  dimension_json=EXCLUDED.dimension_json,
                  updated_at=NOW()
    RETURNING id, account_id, period_id, amount, dimension_json, created_at, updated_at
    `,
    [orgId, forecastId, accountId, periodId || null, amount, dimensionJson || {}]
  );
  return rows[0];
}

// Variance: Forecast vs Actual (uses GL balances)
async function getVariance({ orgId, forecastId, periodId }) {
  const { rows } = await pool.query(
    `
    WITH forecast AS (
      SELECT fl.account_id,
             SUM(fl.amount) AS forecast_amount
      FROM forecast_lines fl
      WHERE fl.organization_id = $1
        AND fl.forecast_id = $2
        AND fl.period_id = $3
      GROUP BY fl.account_id
    ), actual AS (
      SELECT gl.account_id,
             gl.debit_total,
             gl.credit_total,
             (gl.debit_total - gl.credit_total) AS actual_net
      FROM general_ledger_balances gl
      WHERE gl.organization_id = $1
        AND gl.period_id = $3
    )
    SELECT f.account_id,
           coa.code AS account_code,
           coa.name AS account_name,
           f.forecast_amount,
           COALESCE(a.debit_total, 0) AS actual_debit_total,
           COALESCE(a.credit_total, 0) AS actual_credit_total,
           COALESCE(a.actual_net, 0) AS actual_net,
           (COALESCE(a.actual_net, 0) - f.forecast_amount) AS variance
    FROM forecast f
    JOIN chart_of_accounts coa ON coa.id = f.account_id
    LEFT JOIN actual a ON a.account_id = f.account_id
    ORDER BY coa.code
    `,
    [orgId, forecastId, periodId]
  );
  return rows;
}

module.exports = { listForecasts, createForecast, getForecast, upsertLine, getVariance };
