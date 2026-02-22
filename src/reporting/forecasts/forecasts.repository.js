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

async function listLinesPaginated({ orgId, forecastId, forecastVersionId, limit = 100, offset = 0, accountId, periodId }) {
  let query = `
    SELECT 
      fl.*
    FROM forecast_lines fl
    WHERE fl.organization_id = $1 
      AND fl.forecast_id = $2 
      AND fl.forecast_version_id = $3
  `;
  
  const params = [orgId, forecastId, forecastVersionId];
  let paramIndex = 4;
  
  if (accountId) {
    query += ` AND fl.account_id = $${paramIndex}`;
    params.push(accountId);
    paramIndex++;
  }
  
  if (periodId) {
    query += ` AND fl.period_id = $${paramIndex}`;
    params.push(periodId);
    paramIndex++;
  }
  
  query += ` ORDER BY fl.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
  params.push(limit, offset);
  
  const result = await pool.query(query, params);
  
  // Get total count for pagination metadata
  const countResult = await pool.query(
    `SELECT COUNT(*) as total 
     FROM forecast_lines fl 
     WHERE fl.org_id = $1 
       AND fl.forecast_id = $2 
       AND fl.forecast_version_id = $3`,
    [orgId, forecastId, forecastVersionId]
  );
  
  return {
    items: result.rows,
    pagination: {
      total: parseInt(countResult.rows[0].total),
      limit,
      offset,
      hasMore: offset + result.rows.length < parseInt(countResult.rows[0].total)
    }
  };
}
async function listLines({ orgId, forecastId, forecastVersionId, accountId, periodId }) {
  let query = `
    SELECT 
      fl.*
    FROM forecast_lines fl
    WHERE fl.organization_id = $1 
      AND fl.forecast_id = $2 
      AND fl.forecast_version_id = $3
  `;
  
  const params = [orgId, forecastId, forecastVersionId];
  let paramIndex = 4;
  
  if (accountId) {
    query += ` AND fl.account_id = $${paramIndex}`;
    params.push(accountId);
    paramIndex++;
  }
  
  if (periodId) {
    query += ` AND fl.period_id = $${paramIndex}`;
    params.push(periodId);
    paramIndex++;
  }
  
  query += ` ORDER BY fl.created_at DESC`;
  
  const result = await pool.query(query, params);
  console.log(`Found ${result.rows.length} lines for forecastVersionId ${forecastVersionId}`);
  return result.rows;
}
async function getAuditLogs({ orgId, entityType, entityId }) {
  const result = await pool.query(
    `SELECT 
      al.*,
      u.email as user_email,
      u.name as user_name
    FROM audit_logs al
    LEFT JOIN users u ON al.actor_user_id = u.id
    WHERE al.organization_id = $1 
      AND al.entity_type = $2 
      AND al.entity_id = $3
    ORDER BY al.created_at DESC`,
    [orgId, entityType, entityId]
  );
  
  return result.rows;
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

// Get a specific version by ID with its lines
async function getVersionById({ orgId, id, forecastId, includeLines = true }) {
  const params = [orgId, id];
  let sql = `SELECT * FROM forecast_versions WHERE organization_id=$1 AND id=$2`;
  
  if (forecastId) {
    params.push(forecastId);
    sql += ` AND forecast_id=$3`;
  }
  sql += ` LIMIT 1`;
  
  const { rows } = await pool.query(sql, params);
  const version = rows[0] || null;
  
  if (!version) return null;
  
  // If includeLines is true, fetch the lines for this version
  if (includeLines) {
    const linesResult = await pool.query(
      `SELECT * FROM forecast_lines 
       WHERE organization_id=$1 AND forecast_id=$2 AND forecast_version_id=$3 
       ORDER BY created_at DESC`,
      [orgId, version.forecast_id, version.id]
    );
    version.lines = linesResult.rows;
  }
  
  return version;
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

async function updateVersionWorkflow({ orgId, forecastId, versionId, patch }) {
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
    probabilityWeight,
    templateSourceVersionId,
  } = patch || {};

  const { rows } = await pool.query(
    `
    UPDATE forecast_versions
    SET workflow_status = COALESCE($4, workflow_status),
        submitted_at = COALESCE($5, submitted_at),
        submitted_by_user_id = COALESCE($6, submitted_by_user_id),
        approved_at = COALESCE($7, approved_at),
        approved_by_user_id = COALESCE($8, approved_by_user_id),
        rejected_at = COALESCE($9, rejected_at),
        rejected_by_user_id = COALESCE($10, rejected_by_user_id),
        rejection_reason = COALESCE($11, rejection_reason),
        scenario_key = COALESCE($12, scenario_key),
        probability_weight = COALESCE($13, probability_weight),
        template_source_version_id = COALESCE($14, template_source_version_id),
        updated_at = NOW()
    WHERE organization_id=$1 AND forecast_id=$2 AND id=$3
    RETURNING *
    `,
    [
      orgId,
      forecastId,
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
      probabilityWeight === undefined ? null : probabilityWeight,
      templateSourceVersionId || null,
    ]
  );
  return rows[0] || null;
}

async function copyVersion({ orgId, forecastId, sourceVersionId, newVersionNo, name, scenarioKey, probabilityWeight, createdByUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: vrows } = await client.query(
      `
      INSERT INTO forecast_versions(organization_id, forecast_id, version_no, name, status, created_by_user_id, workflow_status, scenario_key, probability_weight, template_source_version_id)
      SELECT organization_id, forecast_id, $4, COALESCE($5, name), 'draft', $8, 'draft', COALESCE($6, scenario_key), COALESCE($7, probability_weight), $3
      FROM forecast_versions
      WHERE organization_id=$1 AND forecast_id=$2 AND id=$3
      RETURNING *
      `,
      [orgId, forecastId, sourceVersionId, newVersionNo, name || null, scenarioKey || null, probabilityWeight === undefined ? null : probabilityWeight, createdByUserId || null]
    );
    const created = vrows[0];
    if (!created) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `
      INSERT INTO forecast_lines(organization_id, forecast_id, forecast_version_id, account_id, period_id, amount, dimension_json)
      SELECT organization_id, forecast_id, $2, account_id, period_id, amount, dimension_json
      FROM forecast_lines
      WHERE organization_id=$1 AND forecast_version_id=$3
      `,
      [orgId, created.id, sourceVersionId]
    );
    await client.query("COMMIT");
    return created;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function compareVersions({ orgId, forecastId, baseVersionId, compareVersionId, periodId }) {
  const params = [orgId, forecastId, baseVersionId, compareVersionId];
  let periodFilter = "";
  if (periodId) {
    params.push(periodId);
    periodFilter = ` AND period_id=$${params.length}`;
  }
  const { rows } = await pool.query(
    `
    WITH base AS (
      SELECT account_id, period_id, SUM(amount) AS amount
      FROM forecast_lines
      WHERE organization_id=$1 AND forecast_id=$2 AND forecast_version_id=$3 ${periodFilter}
      GROUP BY account_id, period_id
    ), cmp AS (
      SELECT account_id, period_id, SUM(amount) AS amount
      FROM forecast_lines
      WHERE organization_id=$1 AND forecast_id=$2 AND forecast_version_id=$4 ${periodFilter}
      GROUP BY account_id, period_id
    )
    SELECT COALESCE(b.account_id, c.account_id) AS account_id,
           coa.code AS account_code,
           coa.name AS account_name,
           COALESCE(b.period_id, c.period_id) AS period_id,
           COALESCE(b.amount, 0) AS base_amount,
           COALESCE(c.amount, 0) AS compare_amount,
           (COALESCE(c.amount, 0) - COALESCE(b.amount, 0)) AS delta
    FROM base b
    FULL OUTER JOIN cmp c
      ON c.account_id=b.account_id AND c.period_id=b.period_id
    JOIN chart_of_accounts coa ON coa.id = COALESCE(b.account_id, c.account_id)
    ORDER BY coa.code
    `,
    params
  );
  return rows;
}

async function forecastVsBudget({ orgId, forecastVersionId, budgetVersionId, periodId }) {
  const { rows } = await pool.query(
    `
    WITH f AS (
      SELECT account_id, SUM(amount) AS forecast_amount
      FROM forecast_lines
      WHERE organization_id=$1 AND forecast_version_id=$2 AND period_id=$4
      GROUP BY account_id
    ), b AS (
      SELECT account_id, SUM(amount) AS budget_amount
      FROM budget_lines
      WHERE organization_id=$1 AND budget_version_id=$3 AND period_id=$4
      GROUP BY account_id
    )
    SELECT COALESCE(f.account_id, b.account_id) AS account_id,
           coa.code AS account_code,
           coa.name AS account_name,
           COALESCE(b.budget_amount, 0) AS budget_amount,
           COALESCE(f.forecast_amount, 0) AS forecast_amount,
           (COALESCE(f.forecast_amount, 0) - COALESCE(b.budget_amount, 0)) AS variance
    FROM f
    FULL OUTER JOIN b ON b.account_id=f.account_id
    JOIN chart_of_accounts coa ON coa.id = COALESCE(f.account_id, b.account_id)
    ORDER BY coa.code
    `,
    [orgId, forecastVersionId, budgetVersionId, periodId]
  );
  return rows;
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
  try {
    
    const query = `
      WITH forecast AS (
        SELECT fl.account_id,
               SUM(fl.amount) AS forecast_amount
        FROM forecast_lines fl
        WHERE fl.organization_id = $1
          AND fl.forecast_id = $2
          AND fl.forecast_version_id = $3
          AND fl.period_id = $4
        GROUP BY fl.account_id
      ), 
      actual AS (
        SELECT gl.account_id,
               gl.debit_total,
               gl.credit_total,
               -- Determine actual balance based on account type's normal balance
               CASE 
                 WHEN at.normal_balance = 'credit' THEN (gl.credit_total - gl.debit_total)
                 WHEN at.normal_balance = 'debit' THEN (gl.debit_total - gl.credit_total)
                 ELSE (gl.debit_total - gl.credit_total) -- Default to debit
               END AS actual_normal,
               at.normal_balance
        FROM general_ledger_balances gl
        INNER JOIN chart_of_accounts coa ON coa.id = gl.account_id
        INNER JOIN account_types at ON at.id = coa.account_type_id
        WHERE gl.organization_id = $1
          AND gl.period_id = $4
      ),
      combined AS (
        SELECT 
          f.account_id,
          coa.code AS account_code,
          coa.name AS account_name,
          at.name AS account_type_name,
          at.normal_balance,
          COALESCE(f.forecast_amount, 0) AS forecast_amount,
          COALESCE(a.debit_total, 0) AS actual_debit_total,
          COALESCE(a.credit_total, 0) AS actual_credit_total,
          COALESCE(a.actual_normal, 0) AS actual_amount,
          (COALESCE(a.actual_normal, 0) - COALESCE(f.forecast_amount, 0)) AS variance_absolute,
          -- Calculate variance percentage (handle division by zero)
          CASE 
            WHEN COALESCE(f.forecast_amount, 0) = 0 THEN NULL
            ELSE ((COALESCE(a.actual_normal, 0) - COALESCE(f.forecast_amount, 0)) / ABS(COALESCE(f.forecast_amount, 1))) * 100
          END AS variance_percentage
        FROM forecast f
        INNER JOIN chart_of_accounts coa ON coa.id = f.account_id
        INNER JOIN account_types at ON at.id = coa.account_type_id
        LEFT JOIN actual a ON a.account_id = f.account_id
        
        UNION ALL
        
        -- Also include accounts that have actuals but no forecast
        SELECT 
          a.account_id,
          coa.code AS account_code,
          coa.name AS account_name,
          at.name AS account_type_name,
          at.normal_balance,
          0 AS forecast_amount,
          a.debit_total AS actual_debit_total,
          a.credit_total AS actual_credit_total,
          a.actual_normal AS actual_amount,
          (a.actual_normal - 0) AS variance_absolute,
          NULL AS variance_percentage
        FROM actual a
        INNER JOIN chart_of_accounts coa ON coa.id = a.account_id
        INNER JOIN account_types at ON at.id = coa.account_type_id
        WHERE a.account_id NOT IN (SELECT account_id FROM forecast)
      )
      SELECT *,
        CASE 
          WHEN variance_absolute > 0 THEN 'over'
          WHEN variance_absolute < 0 THEN 'under'
          ELSE 'on_target'
        END AS variance_direction
      FROM combined
      ORDER BY account_code
    `;
    
    const { rows } = await pool.query(query, [
      orgId, 
      forecastId, 
      forecastVersionId, 
      periodId
    ]);
    
    console.log(`Found ${rows.length} variance records`);
    return rows;
    
  } catch (error) {
    console.error('Error in getVariance:', error.message);
    console.error('Query parameters:', { orgId, forecastId, forecastVersionId, periodId });
    throw error;
  }
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
  updateVersionWorkflow,
  copyVersion,
  compareVersions,
  forecastVsBudget,
  activateForecast,
  archiveForecast,
  finalizeVersion,
  upsertLine,
  getVariance,
  listLines,
  listLinesPaginated,
  getAuditLogs,
};
