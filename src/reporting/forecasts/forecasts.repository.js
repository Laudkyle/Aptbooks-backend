const { pool } = require("../../db/pool");

// ============================
// Existing Functions
// ============================

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
     WHERE fl.organization_id = $1 
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
    SELECT 
      fv.id, 
      fv.forecast_id, 
      fv.version_no, 
      fv.name, 
      fv.status,
      fv.workflow_status,
      fv.probability_weight,
      fv.scenario_id,
      fv.created_at, 
      fv.updated_at,
      fv.submitted_at,
      fv.approved_at,
      fv.rejected_at,
      fv.finalized_at,
      fv.rejection_reason,
      s.id as scenario_id,
      s.code as scenario_code,
      s.name as scenario_name,
      s.description as scenario_description,
      s.is_default as scenario_is_default,
      s.is_active as scenario_is_active
    FROM forecast_versions fv
    LEFT JOIN scenarios s ON s.id = fv.scenario_id AND s.deleted_at IS NULL
    WHERE fv.organization_id=$1 AND fv.forecast_id=$2
    ORDER BY fv.version_no DESC
    `,
    [orgId, forecastId]
  );
  
  // Transform the rows to nest scenario data
  return rows.map(row => ({
    id: row.id,
    forecast_id: row.forecast_id,
    version_no: row.version_no,
    name: row.name,
    status: row.status,
    workflow_status: row.workflow_status,
    probability_weight: row.probability_weight,
    scenario_id: row.scenario_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
    finalized_at: row.finalized_at,
    rejection_reason: row.rejection_reason,
    scenario: row.scenario_id ? {
      id: row.scenario_id,
      code: row.scenario_code,
      name: row.scenario_name,
      description: row.scenario_description,
      is_default: row.scenario_is_default,
      is_active: row.scenario_is_active
    } : null
  }));
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
  let sql = `
    SELECT 
      fv.*,
      s.id as scenario_id,
      s.code as scenario_code,
      s.name as scenario_name,
      s.description as scenario_description,
      s.is_default as scenario_is_default,
      s.is_active as scenario_is_active
    FROM forecast_versions fv
    LEFT JOIN scenarios s ON s.id = fv.scenario_id AND s.deleted_at IS NULL
    WHERE fv.organization_id=$1 AND fv.id=$2
  `;
  
  if (forecastId) {
    params.push(forecastId);
    sql += ` AND fv.forecast_id=$3`;
  }
  sql += ` LIMIT 1`;
  
  const { rows } = await pool.query(sql, params);
  
  if (rows.length === 0) return null;
  
  const row = rows[0];
  
  // Build version object with nested scenario
  const version = {
    id: row.id,
    forecast_id: row.forecast_id,
    version_no: row.version_no,
    name: row.name,
    status: row.status,
    workflow_status: row.workflow_status,
    probability_weight: row.probability_weight,
    scenario_id: row.scenario_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
    finalized_at: row.finalized_at,
    rejection_reason: row.rejection_reason,
    created_by_user_id: row.created_by_user_id,
    submitted_by_user_id: row.submitted_by_user_id,
    approved_by_user_id: row.approved_by_user_id,
    rejected_by_user_id: row.rejected_by_user_id,
    template_source_version_id: row.template_source_version_id,
    dimension_json: row.dimension_json,
    // Add nested scenario object
    scenario: row.scenario_id ? {
      id: row.scenario_id,
      code: row.scenario_code,
      name: row.scenario_name,
      description: row.scenario_description,
      is_default: row.scenario_is_default,
      is_active: row.scenario_is_active
    } : null
  };
  
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

async function finalizeVersion({ orgId, forecastId, versionId, actorUserId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // First, get the version we're trying to finalize
    const { rows: versionToFinalize } = await client.query(
      `SELECT * FROM forecast_versions 
       WHERE organization_id = $1 
         AND forecast_id = $2 
         AND id = $3 
         AND status = 'draft'`,
      [orgId, forecastId, versionId]
    );
    
    if (versionToFinalize.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    
    const version = versionToFinalize[0];
    
    // Get ALL active versions before archiving them
    const { rows: activeVersions } = await client.query(
      `SELECT id, version_no, name, created_at, workflow_status 
       FROM forecast_versions 
       WHERE organization_id = $1 
         AND forecast_id = $2 
         AND status = 'active'
       ORDER BY version_no DESC`,
      [orgId, forecastId]
    );
    
    // Archive ALL active versions
    if (activeVersions.length > 0) {
      const activeIds = activeVersions.map(v => v.id);
      
      await client.query(
        `UPDATE forecast_versions 
         SET status = 'archived', 
             updated_at = NOW(),
             archived_at = NOW(),
             archived_by_user_id = $2
         WHERE id = ANY($1::uuid[])`,
        [activeIds, actorUserId]
      );
      
      console.log(`Archived ${activeVersions.length} active version(s): ${activeVersions.map(v => `v${v.version_no}`).join(', ')}`);
    }
    
    // Now finalize the draft version (make it active)
    const { rows } = await client.query(
      `UPDATE forecast_versions
       SET status = 'active', 
           updated_at = NOW(),
           finalized_at = NOW(),
           finalized_by_user_id = $2
       WHERE organization_id = $1 
         AND forecast_id = $3 
         AND id = $4 
         AND status = 'draft'
       RETURNING *`,
      [orgId, actorUserId, forecastId, versionId]
    );
    
    await client.query('COMMIT');
    
    // Return the finalized version with detailed info
    const finalized = rows[0];
    return {
      ...finalized,
      previous_versions: activeVersions.map(v => ({
        id: v.id,
        version_no: v.version_no,
        name: v.name,
        workflow_status: v.workflow_status,
        created_at: v.created_at
      })),
      summary: {
        versions_archived: activeVersions.length,
        new_active_version: finalized.version_no,
        message: activeVersions.length > 0 
          ? `Version ${finalized.version_no} is now active. ${activeVersions.length} previous version(s) have been archived.`
          : `Version ${finalized.version_no} is now active.`
      }
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
async function createVersion({ orgId, forecastId, versionNo, name, probabilityWeight,scenarioId,status, createdByUserId }) {
  const { rows } = await pool.query(
    `
    INSERT INTO forecast_versions(organization_id, forecast_id, version_no, name, probability_weight, scenario_id, status, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id, forecast_id, version_no, name, probability_weight, scenario_id, status, created_at, updated_at
    `,
    [orgId, forecastId, versionNo, name, probabilityWeight || null, scenarioId || null, status || 'draft', createdByUserId || null]
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
    scenarioId,
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
        scenario_id = COALESCE($12, scenario_id),
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
      scenarioId || null,
      probabilityWeight === undefined ? null : probabilityWeight,
      templateSourceVersionId || null,
    ]
  );
  return rows[0] || null;
}

async function updateForecast({ orgId, forecastId, patch }) {
  const { rows } = await pool.query(
    `UPDATE forecasts 
     SET name = COALESCE($1, name),
         currency_code = COALESCE($2, currency_code),
         status = COALESCE($3, status),
         fiscal_year = COALESCE($4, fiscal_year),
         updated_at = NOW()
     WHERE id = $5 AND organization_id = $6
     RETURNING *`,
    [patch.name, patch.currency_code, patch.status, patch.fiscal_year, forecastId, orgId]
  );
  return rows[0];
}

async function updateForecastVersion({ orgId, forecastId, versionId, patch }) {
  const { rows } = await pool.query(
    `UPDATE forecast_versions 
     SET version_no = COALESCE($1, version_no),
         name = COALESCE($2, name),
         status = COALESCE($3, status),
         scenario_id = COALESCE($4, scenario_id),
         probability_weight = COALESCE($5, probability_weight),
         updated_at = NOW()
     WHERE id = $6 AND forecast_id = $7 AND organization_id = $8
     RETURNING *`,
    [
      patch.version_no, 
      patch.name, 
      patch.status, 
      patch.scenarioId, 
      patch.probability_weight, 
      versionId, 
      forecastId, 
      orgId
    ]
  );
  return rows[0];
}

async function copyVersion({ orgId, forecastId, sourceVersionId, newVersionNo, name, scenarioId, probabilityWeight, createdByUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: vrows } = await client.query(
      `
      INSERT INTO forecast_versions(
        organization_id, forecast_id, version_no, name, status, 
        created_by_user_id, workflow_status, scenario_id, probability_weight, template_source_version_id
      )
      SELECT 
        organization_id, forecast_id, $4, COALESCE($5, name), 'draft', 
        $8, 'draft', COALESCE($6, scenario_id), COALESCE($7, probability_weight), $3
      FROM forecast_versions
      WHERE organization_id=$1 AND forecast_id=$2 AND id=$3
      RETURNING *
      `,
      [
        orgId, 
        forecastId, 
        sourceVersionId, 
        newVersionNo, 
        name || null, 
        scenarioId || null, 
        probabilityWeight === undefined ? null : probabilityWeight, 
        createdByUserId || null
      ]
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

// ============================
// NEW: Scenario Management Functions
// ============================

/**
 * List all scenarios for an organization
 */
async function listScenarios({ orgId, includeInactive = false }) {
  const query = `
    SELECT 
      s.*,
      COUNT(fv.id) as version_count
    FROM scenarios s
    LEFT JOIN forecast_versions fv ON fv.scenario_id = s.id AND fv.deleted_at IS NULL
    WHERE s.organization_id = $1
      AND s.deleted_at IS NULL
      ${!includeInactive ? 'AND s.is_active = true' : ''}
    GROUP BY s.id
    ORDER BY s.is_default DESC, s.name ASC
  `;
  
  const { rows } = await pool.query(query, [orgId]);
  return rows;
}

/**
 * Get a scenario by ID
 */
async function getScenarioById({ orgId, scenarioId }) {
  const { rows } = await pool.query(
    `SELECT * FROM scenarios 
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [scenarioId, orgId]
  );
  return rows[0];
}

/**
 * Get a scenario by code
 */
async function getScenarioByCode({ orgId, code }) {
  const { rows } = await pool.query(
    `SELECT * FROM scenarios 
     WHERE organization_id = $1 AND UPPER(code) = UPPER($2) AND deleted_at IS NULL`,
    [orgId, code]
  );
  return rows[0];
}

/**
 * Create a new scenario
 */
async function createScenario({ orgId, code, name, description, isDefault, isActive, metadata, createdByUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // If this is set as default, unset any existing default
    if (isDefault) {
      await client.query(
        `UPDATE scenarios SET is_default = false 
         WHERE organization_id = $1 AND is_default = true AND deleted_at IS NULL`,
        [orgId]
      );
    }

    const { rows } = await client.query(
      `INSERT INTO scenarios (
          organization_id, code, name, description, 
          is_default, is_active, metadata, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [orgId, code, name, description, isDefault, isActive, metadata, createdByUserId]
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Update an existing scenario
 */
async function updateScenario({ orgId, scenarioId, patch, updatedByUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // If setting as default, unset any existing default
    if (patch.is_default) {
      await client.query(
        `UPDATE scenarios SET is_default = false 
         WHERE organization_id = $1 AND is_default = true AND id != $2 AND deleted_at IS NULL`,
        [orgId, scenarioId]
      );
    }

    const { rows } = await client.query(
      `UPDATE scenarios 
       SET code = COALESCE($1, code),
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           is_default = COALESCE($4, is_default),
           is_active = COALESCE($5, is_active),
           metadata = COALESCE($6, metadata),
           updated_by_user_id = $7,
           updated_at = NOW()
       WHERE id = $8 AND organization_id = $9 AND deleted_at IS NULL
       RETURNING *`,
      [
        patch.code,
        patch.name,
        patch.description,
        patch.is_default,
        patch.is_active,
        patch.metadata,
        updatedByUserId,
        scenarioId,
        orgId
      ]
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Soft delete a scenario (mark as deleted)
 */
async function softDeleteScenario({ orgId, scenarioId, updatedByUserId }) {
  const { rows } = await pool.query(
    `UPDATE scenarios 
     SET deleted_at = NOW(),
         updated_by_user_id = $3,
         updated_at = NOW()
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [scenarioId, orgId, updatedByUserId]
  );
  return rows[0];
}

/**
 * Hard delete a scenario (only if not used)
 */
async function hardDeleteScenario({ orgId, scenarioId }) {
  const { rows } = await pool.query(
    `DELETE FROM scenarios 
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [scenarioId, orgId]
  );
  return rows[0];
}

/**
 * Get count of forecast versions using a scenario
 */
async function getScenarioUsageCount({ orgId, scenarioId }) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as count 
     FROM forecast_versions 
     WHERE organization_id = $1 
       AND scenario_id = $2 
       AND deleted_at IS NULL`,
    [orgId, scenarioId]
  );
  return parseInt(rows[0].count);
}

/**
 * Get scenarios with usage statistics
 */
async function getScenariosWithStats({ orgId }) {
  const { rows } = await pool.query(
    `SELECT 
        s.*,
        COUNT(fv.id) as version_count,
        SUM(CASE WHEN fv.status = 'draft' THEN 1 ELSE 0 END) as draft_count,
        SUM(CASE WHEN fv.workflow_status = 'approved' THEN 1 ELSE 0 END) as approved_count,
        SUM(CASE WHEN fv.workflow_status = 'in_review' THEN 1 ELSE 0 END) as in_review_count
     FROM scenarios s
     LEFT JOIN forecast_versions fv ON fv.scenario_id = s.id AND fv.deleted_at IS NULL
     WHERE s.organization_id = $1 AND s.deleted_at IS NULL
     GROUP BY s.id
     ORDER BY s.is_default DESC, s.name ASC`,
    [orgId]
  );
  return rows;
}

/**
 * Restore a soft-deleted scenario
 */
async function restoreScenario({ orgId, scenarioId, updatedByUserId }) {
  const { rows } = await pool.query(
    `UPDATE scenarios 
     SET deleted_at = NULL,
         updated_by_user_id = $3,
         updated_at = NOW()
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NOT NULL
     RETURNING *`,
    [scenarioId, orgId, updatedByUserId]
  );
  return rows[0];
}

// ============================
// Module Exports
// ============================
module.exports = {
  // Account & Period validation
  assertAccountWritable,
  assertPeriodExists,
  
  // Forecasts
  listForecasts,
  createForecastWithDefaultVersion,
  getForecast,
  activateForecast,
  archiveForecast,
  updateForecast,
  
  // Versions
  listVersions,
  getVersion,
  getVersionById,
  getLatestDraftVersion,
  getLatestActiveOrDraftVersion,
  createVersion,
  updateVersionWorkflow,
  updateForecastVersion,
  finalizeVersion,
  copyVersion,
  
  // Lines
  upsertLine,
  listLines,
  listLinesPaginated,
  
  // Analysis
  compareVersions,
  forecastVsBudget,
  getVariance,
  
  // Audit
  getAuditLogs,
  
  // Scenarios
  listScenarios,
  getScenarioById,
  getScenarioByCode,
  createScenario,
  updateScenario,
  softDeleteScenario,
  hardDeleteScenario,
  getScenarioUsageCount,
  getScenariosWithStats,
  restoreScenario,
};