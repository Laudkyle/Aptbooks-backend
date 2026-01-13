const { pool } = require("../../db/pool");

async function assertAccountWritable({ orgId, accountId }) {
  const { rows } = await pool.query(
    `
      SELECT id, is_postable, status
      FROM chart_of_accounts
      WHERE organization_id=$1 AND id=$2
      LIMIT 1
    `,
    [orgId, accountId]
  );
  if (!rows.length) return { ok: false, reason: "not_found" };
  const r = rows[0];
  if (!r.is_postable) return { ok: false, reason: "not_postable" };
  if ((r.status || "active") !== "active") return { ok: false, reason: "inactive" };
  return { ok: true };
}

async function assertPeriodExists({ orgId, periodId }) {
  const { rows } = await pool.query(
    `SELECT id, status FROM accounting_periods WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, periodId]
  );
  if (!rows.length) return { ok: false, reason: "not_found" };
  return { ok: true, status: rows[0].status };
}

async function listForecasts({ orgId, limit = 100, offset = 0, status }) {
  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (status) {
    params.push(status);
    where += ` AND status=$${params.length}`;
  }
  params.push(limit);
  params.push(offset);

  const { rows } = await pool.query(
    `
    SELECT id, name, currency_code, status, created_at, updated_at
    FROM forecasts
    ${where}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );
  return rows;
}

async function createForecastWithDefaultVersion({ orgId, name, currencyCode, status, createdByUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: fr } = await client.query(
      `
      INSERT INTO forecasts(organization_id, name, currency_code, status, created_by_user_id)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id, name, currency_code, status, created_at, updated_at
      `,
      [orgId, name, currencyCode, status, createdByUserId || null]
    );
    const forecast = fr[0];

    const { rows: vr } = await client.query(
      `
      INSERT INTO forecast_versions(organization_id, forecast_id, version_no, name, status, created_by_user_id)
      VALUES ($1,$2,1,$3,'draft',$4)
      RETURNING id, forecast_id, version_no, name, status, created_at, updated_at
      `,
      [orgId, forecast.id, "Version 1", createdByUserId || null]
    );
    const version = vr[0];

    await client.query("COMMIT");
    return { forecast, version };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getForecast({ orgId, id }) {
  const { rows } = await pool.query(
    `SELECT * FROM forecasts WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, id]
  );
  return rows.length ? rows[0] : null;
}

async function listVersions({ orgId, forecastId }) {
  const { rows } = await pool.query(
    `
    SELECT id, forecast_id, version_no, name, status, created_at, updated_at
    FROM forecast_versions
    WHERE organization_id=$1 AND forecast_id=$2
    ORDER BY version_no DESC
    `,
    [orgId, forecastId]
  );
  return rows;
}

async function getVersion({ orgId, versionId }) {
  const { rows } = await pool.query(
    `SELECT * FROM forecast_versions WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, versionId]
  );
  return rows.length ? rows[0] : null;
}

// Compatibility helper: some call-sites pass { id } and optionally { forecastId }
async function getVersionById({ orgId, id, forecastId }) {
  const params = [orgId, id];
  let sql = `SELECT * FROM forecast_versions WHERE organization_id=$1 AND id=$2`;
  if (forecastId) {
    params.push(forecastId);
    sql += ` AND forecast_id=$3`;
  }
  sql += ` LIMIT 1`;
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function getLatestDraftVersion({ orgId, forecastId }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM forecast_versions
    WHERE organization_id=$1 AND forecast_id=$2 AND status='draft'
    ORDER BY version_no DESC
    LIMIT 1
    `,
    [orgId, forecastId]
  );
  return rows.length ? rows[0] : null;
}

async function getLatestActiveOrDraftVersion({ orgId, forecastId }) {
  const { rows } = await pool.query(
    `
      SELECT *
      FROM forecast_versions
      WHERE organization_id=$1 AND forecast_id=$2 AND status IN ('draft','active')
      ORDER BY version_no DESC
      LIMIT 1
    `,
    [orgId, forecastId]
  );
  return rows[0] || null;
}

async function activateForecast({ orgId, forecastId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE forecasts SET status='active', updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, forecastId]
    );
    // Ensure at least one version is active.
    const { rows: v } = await client.query(
      `
        UPDATE forecast_versions
        SET status='active', updated_at=NOW()
        WHERE organization_id=$1 AND forecast_id=$2
          AND id = (
            SELECT id FROM forecast_versions
            WHERE organization_id=$1 AND forecast_id=$2
              AND status IN ('draft','active')
            ORDER BY version_no DESC
            LIMIT 1
          )
        RETURNING *
      `,
      [orgId, forecastId]
    );
    await client.query("COMMIT");
    return v[0] || null;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function archiveForecast({ orgId, forecastId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE forecasts SET status='archived', updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, forecastId]
    );
    await client.query(
      `UPDATE forecast_versions SET status='archived', updated_at=NOW() WHERE organization_id=$1 AND forecast_id=$2`,
      [orgId, forecastId]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function finalizeVersion({ orgId, forecastId, versionId }) {
  const { rows } = await pool.query(
    `
      UPDATE forecast_versions
      SET status='active', updated_at=NOW()
      WHERE organization_id=$1 AND forecast_id=$2 AND id=$3 AND status='draft'
      RETURNING *
    `,
    [orgId, forecastId, versionId]
  );
  return rows[0] || null;
}

async function createVersion({ orgId, forecastId, versionNo, name, status, createdByUserId }) {
  const { rows } = await pool.query(
    `
    INSERT INTO forecast_versions(organization_id, forecast_id, version_no, name, status, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id, forecast_id, version_no, name, status, created_at, updated_at
    `,
    [orgId, forecastId, versionNo, name, status, createdByUserId || null]
  );
  return rows[0];
}

async function upsertLine({ orgId, forecastId, forecastVersionId, accountId, periodId, amount, dimensionJson }) {
  const { rows } = await pool.query(
    `
    INSERT INTO forecast_lines(organization_id, forecast_id, forecast_version_id, account_id, period_id, amount, dimension_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (forecast_version_id, account_id, period_id)
    DO UPDATE SET amount=EXCLUDED.amount,
                  dimension_json=EXCLUDED.dimension_json,
                  updated_at=NOW()
    RETURNING id, account_id, period_id, amount, dimension_json, created_at, updated_at
    `,
    [orgId, forecastId, forecastVersionId, accountId, periodId || null, amount, dimensionJson || {}]
  );
  return rows[0];
}

async function getVariance({ orgId, forecastId, forecastVersionId, periodId }) {
  const { rows } = await pool.query(
    `
    WITH forecast AS (
      SELECT fl.account_id,
             SUM(fl.amount) AS forecast_amount
      FROM forecast_lines fl
      WHERE fl.organization_id = $1
        AND fl.forecast_id = $2
        AND fl.forecast_version_id = $3
        AND fl.period_id = $4
      GROUP BY fl.account_id
    ), actual AS (
      SELECT gl.account_id,
             gl.debit_total,
             gl.credit_total,
             CASE WHEN coa.normal_balance='credit'
                  THEN (gl.credit_total - gl.debit_total)
                  ELSE (gl.debit_total - gl.credit_total)
             END AS actual_normal
      FROM general_ledger_balances gl
      JOIN chart_of_accounts coa ON coa.id = gl.account_id
      WHERE gl.organization_id = $1
        AND gl.period_id = $4
    )
    SELECT f.account_id,
           coa.code AS account_code,
           coa.name AS account_name,
           coa.normal_balance,
           f.forecast_amount,
           COALESCE(a.debit_total, 0) AS actual_debit_total,
           COALESCE(a.credit_total, 0) AS actual_credit_total,
           COALESCE(a.actual_normal, 0) AS actual_amount,
           (COALESCE(a.actual_normal, 0) - f.forecast_amount) AS variance
    FROM forecast f
    JOIN chart_of_accounts coa ON coa.id = f.account_id
    LEFT JOIN actual a ON a.account_id = f.account_id
    ORDER BY coa.code
    `,
    [orgId, forecastId, forecastVersionId, periodId]
  );
  return rows;
}

module.exports = {
  assertAccountWritable,
  assertPeriodExists,
  listForecasts,
  createForecastWithDefaultVersion,
  getForecast,
  listVersions,
  getVersion,
  getVersionById,
  getLatestDraftVersion,
  getLatestActiveOrDraftVersion,
  createVersion,
  activateForecast,
  archiveForecast,
  finalizeVersion,
  upsertLine,
  getVariance,
};
