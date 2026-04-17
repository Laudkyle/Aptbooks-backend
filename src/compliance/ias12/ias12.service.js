const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const Decimal = require("decimal.js");
const journalPosting = require("../../interfaces/journalPosting.interface");
const crypto = require("crypto");
const logger = require("../../config/logger");

// --------------------------------------
// Helpers
// --------------------------------------

async function getPeriodOrThrow(client, orgId, periodId) {
  const { rows } = await client.query(
    `SELECT id, status, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(400, "Invalid period_id");
  return rows[0];
}

async function resolveEffectiveRateOrThrow(client, orgId, rateSetId, periodEndDate) {
  const { rows: rsRows } = await client.query(
    `SELECT id, status FROM ias12_tax_rate_sets WHERE organization_id=$1 AND id=$2`,
    [orgId, rateSetId]
  );
  if (!rsRows.length) throw new AppError(400, "Invalid rate_set_id");
  if (rsRows[0].status !== "active") throw new AppError(409, "Rate set is inactive");

  const { rows } = await client.query(
    `
    SELECT rate, effective_from, effective_to
    FROM ias12_tax_rate_lines
    WHERE rate_set_id=$1
      AND effective_from <= $2
      AND (effective_to IS NULL OR effective_to >= $2)
    ORDER BY effective_from DESC
    LIMIT 1
    `,
    [rateSetId, periodEndDate]
  );
  if (!rows.length) throw new AppError(409, "No tax rate line covers the period end date");
  return { rate: rows[0].rate, effective_from: rows[0].effective_from, effective_to: rows[0].effective_to };
}

async function listAuthorities({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT id, code, name, country_code, country_code AS country, status, created_at, updated_at
    FROM ias12_tax_authorities
    WHERE organization_id=$1
    ORDER BY code ASC
    `,
    [orgId]
  );
  return rows;
}

async function createAuthority({ orgId, actorUserId, payload }) {
  try {
    const { rows } = await pool.query(
      `
      INSERT INTO ias12_tax_authorities(
        organization_id, code, name, country_code, status, created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, code, name, country_code, country_code AS country, status, created_at, updated_at
      `,
      [
        orgId,
        payload.code,
        payload.name,
        payload.country_code || null,
        payload.status || "active",
        actorUserId || null,
      ]
    );
    return rows[0];
  } catch (err) {
    // Unique(org, code)
    if (err.code === "23505") {
      throw new AppError(409, "Authority code already exists for organization");
    }
    throw err;
  }
}

async function updateAuthority({ orgId, actorUserId, authorityId, payload }) {
  const { rows: existing } = await pool.query(
    `SELECT id FROM ias12_tax_authorities WHERE organization_id=$1 AND id=$2`,
    [orgId, authorityId]
  );
  if (!existing.length) throw new AppError(404, "Authority not found");

  const { rows } = await pool.query(
    `
    UPDATE ias12_tax_authorities
    SET
      name = COALESCE($3, name),
      country_code = COALESCE($4, country_code),
      status = COALESCE($5, status),
      updated_at = NOW(),
      updated_by = $6
    WHERE organization_id=$1 AND id=$2
    RETURNING id, code, name, country_code, country_code AS country, status, created_at, updated_at
    `,
    [
      orgId,
      authorityId,
      payload.name || null,
      payload.country_code || null,
      payload.status || null,
      actorUserId || null,
    ]
  );
  return rows[0];
}

// --------------------------------------
// Rate sets
// --------------------------------------

async function listRateSets({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT
      rs.id,
      rs.authority_id,
      a.code AS authority_code,
      a.name AS authority_name,
      rs.code,
      rs.name,
      rs.status,
      rs.created_at,
      rs.updated_at
    FROM ias12_tax_rate_sets rs
    JOIN ias12_tax_authorities a ON a.id = rs.authority_id
    WHERE rs.organization_id=$1
    ORDER BY a.code ASC, rs.code ASC
    `,
    [orgId]
  );
  return rows;
}

async function createRateSet({ orgId, actorUserId, payload }) {
  // Ensure authority belongs to org
  const { rows: authRows } = await pool.query(
    `SELECT id FROM ias12_tax_authorities WHERE organization_id=$1 AND id=$2`,
    [orgId, payload.authority_id]
  );
  if (!authRows.length) throw new AppError(400, "Invalid authority_id");

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO ias12_tax_rate_sets(
        organization_id, authority_id, code, name, status, created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, authority_id, code, name, status, created_at, updated_at
      `,
      [
        orgId,
        payload.authority_id,
        payload.code,
        payload.name,
        payload.status || "active",
        actorUserId || null,
      ]
    );
    return rows[0];
  } catch (err) {
    if (err.code === "23505") {
      throw new AppError(409, "Rate set code already exists for organization");
    }
    throw err;
  }
}

async function listRateLines({ orgId, rateSetId }) {
  // Ensure rate set belongs to org
  const { rows: rsRows } = await pool.query(
    `SELECT id FROM ias12_tax_rate_sets WHERE organization_id=$1 AND id=$2`,
    [orgId, rateSetId]
  );
  if (!rsRows.length) throw new AppError(404, "Rate set not found");

  const { rows } = await pool.query(
    `
    SELECT id, effective_from, effective_to, rate, created_at, updated_at
    FROM ias12_tax_rate_lines
    WHERE rate_set_id=$1
    ORDER BY effective_from ASC
    `,
    [rateSetId]
  );
  return rows;
}

async function addRateLine({ orgId, actorUserId, rateSetId, payload }) {
  // Ensure rate set belongs to org
  const { rows: rsRows } = await pool.query(
    `SELECT id FROM ias12_tax_rate_sets WHERE organization_id=$1 AND id=$2`,
    [orgId, rateSetId]
  );
  if (!rsRows.length) throw new AppError(404, "Rate set not found");

  const effectiveFrom = payload.effective_from;
  const effectiveTo = payload.effective_to || null;

  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw new AppError(400, "effective_to cannot be before effective_from");
  }

  // Prevent overlap within a rate set (simple rule)
  // Overlap condition: existing_from <= new_to AND existing_to >= new_from
  const { rows: overlaps } = await pool.query(
    `
    SELECT 1
    FROM ias12_tax_rate_lines
    WHERE rate_set_id=$1
      AND (
        (effective_to IS NULL OR effective_to >= $2)
        AND ($3::timestamp IS NULL OR effective_from <= $3)
      )
    LIMIT 1
    `,
    [rateSetId, effectiveFrom, effectiveTo]
  );
  if (overlaps.length) {
    throw new AppError(409, "Tax rate lines overlap for this rate set");
  }

  const { rows } = await pool.query(
    `
    INSERT INTO ias12_tax_rate_lines(
      rate_set_id, effective_from, effective_to, rate, created_by
    )
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id, effective_from, effective_to, rate, created_at, updated_at
    `,
    [rateSetId, effectiveFrom, effectiveTo, payload.rate, actorUserId || null]
  );
  return rows[0];
}

// --------------------------------------
// Settings
// --------------------------------------

async function getSettings({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT
      organization_id,
      default_authority_id,
      default_rate_set_id,
      deferred_tax_asset_account_id,
      deferred_tax_liability_account_id,
      deferred_tax_expense_account_id,
      rounding_decimals,
      created_at,
      updated_at
    FROM ias12_settings
    WHERE organization_id=$1
    `,
    [orgId]
  );
  return rows[0] || {
    organization_id: orgId,
    default_authority_id: null,
    default_rate_set_id: null,
    deferred_tax_asset_account_id: null,
    deferred_tax_liability_account_id: null,
    deferred_tax_expense_account_id: null,
    rounding_decimals: 2,
  };
}

async function upsertSettings({ orgId, actorUserId, payload }) {
  // Validate authority/rate_set belong to org if provided
  if (payload.default_authority_id) {
    const { rows } = await pool.query(
      `SELECT id FROM ias12_tax_authorities WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.default_authority_id]
    );
    if (!rows.length) throw new AppError(400, "Invalid default_authority_id");
  }
  if (payload.default_rate_set_id) {
    const { rows } = await pool.query(
      `SELECT id FROM ias12_tax_rate_sets WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.default_rate_set_id]
    );
    if (!rows.length) throw new AppError(400, "Invalid default_rate_set_id");
  }

  // Validate COA account ownership if provided
  const validateCoa = async (accountId, fieldName) => {
    if (!accountId) return;
    const { rows } = await pool.query(
      `
      SELECT id FROM chart_of_accounts
      WHERE organization_id=$1 AND id=$2 AND status='active' AND is_postable=TRUE
      `,
      [orgId, accountId]
    );
    if (!rows.length) throw new AppError(400, `Invalid ${fieldName}`);
  };

  await validateCoa(payload.deferred_tax_asset_account_id, "deferred_tax_asset_account_id");
  await validateCoa(payload.deferred_tax_liability_account_id, "deferred_tax_liability_account_id");
  await validateCoa(payload.deferred_tax_expense_account_id, "deferred_tax_expense_account_id");

  const rounding =
    payload.rounding_decimals === undefined ? null : payload.rounding_decimals;

  const { rows } = await pool.query(
    `
    INSERT INTO ias12_settings(
      organization_id,
      default_authority_id,
      default_rate_set_id,
      deferred_tax_asset_account_id,
      deferred_tax_liability_account_id,
      deferred_tax_expense_account_id,
      rounding_decimals,
      created_by,
      updated_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,2),$8,$8)
    ON CONFLICT (organization_id)
    DO UPDATE SET
      default_authority_id = COALESCE(EXCLUDED.default_authority_id, ias12_settings.default_authority_id),
      default_rate_set_id = COALESCE(EXCLUDED.default_rate_set_id, ias12_settings.default_rate_set_id),
      deferred_tax_asset_account_id = COALESCE(EXCLUDED.deferred_tax_asset_account_id, ias12_settings.deferred_tax_asset_account_id),
      deferred_tax_liability_account_id = COALESCE(EXCLUDED.deferred_tax_liability_account_id, ias12_settings.deferred_tax_liability_account_id),
      deferred_tax_expense_account_id = COALESCE(EXCLUDED.deferred_tax_expense_account_id, ias12_settings.deferred_tax_expense_account_id),
      rounding_decimals = COALESCE(EXCLUDED.rounding_decimals, ias12_settings.rounding_decimals),
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by
    RETURNING
      organization_id,
      default_authority_id,
      default_rate_set_id,
      deferred_tax_asset_account_id,
      deferred_tax_liability_account_id,
      deferred_tax_expense_account_id,
      rounding_decimals,
      created_at,
      updated_at
    `,
    [
      orgId,
      payload.default_authority_id || null,
      payload.default_rate_set_id || null,
      payload.deferred_tax_asset_account_id || null,
      payload.deferred_tax_liability_account_id || null,
      payload.deferred_tax_expense_account_id || null,
      rounding,
      actorUserId || null,
    ]
  );
  return rows[0];
}

// --------------------------------------
// Stage 1: Temporary differences + deferred tax runs + posting
// --------------------------------------

async function listTempDifferenceCategories({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT id, code, name, status, created_at, updated_at
    FROM ias12_temp_difference_categories
    WHERE organization_id=$1
    ORDER BY code ASC
    `,
    [orgId]
  );
  return rows;
}

async function createTempDifferenceCategory({ orgId, actorUserId, payload }) {
  try {
    const { rows } = await pool.query(
      `
      INSERT INTO ias12_temp_difference_categories(
        organization_id, code, name, status
      )
      VALUES ($1,$2,$3,$4)
      RETURNING id, code, name, status, created_at, updated_at
      `,
      [orgId, payload.code, payload.name, payload.status || "active"]
    );
    return rows[0];
  } catch (err) {
    if (err.code === "23505") {
      throw new AppError(409, "Temp difference category code already exists for organization");
    }
    throw err;
  }
}

async function assertPeriodExists({ orgId, periodId }) {
  const { rows } = await pool.query(
    `SELECT id, status, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(400, "Invalid period_id");
  return rows[0];
}

async function listTempDifferences({ orgId, periodId }) {
  await assertPeriodExists({ orgId, periodId });
  const { rows } = await pool.query(
    `
    SELECT
      td.id,
      td.period_id,
      td.category_id,
      c.code AS category_code,
      c.name AS category_name,
      td.source_type,
      td.source_id,
      td.diff_type,
      td.carrying_amount,
      td.tax_base,
      (td.carrying_amount - td.tax_base) AS difference,
      td.recognisable,
      td.notes,
      td.created_at,
      td.updated_at
    FROM ias12_temp_differences td
    JOIN ias12_temp_difference_categories c ON c.id = td.category_id
    WHERE td.organization_id=$1 AND td.period_id=$2
      AND COALESCE(td.is_active, TRUE) = TRUE
    ORDER BY c.code ASC, td.created_at ASC
    `,
    [orgId, periodId]
  );
  return rows;
}

async function isTempDifferenceLocked(client, { orgId, tempDifferenceId }) {
  const { rows } = await client.query(
    `
    SELECT 1
    FROM ias12_deferred_tax_run_lines l
    JOIN ias12_deferred_tax_runs r ON r.id = l.run_id
    JOIN ias12_temp_differences td ON td.id = l.temp_difference_id
    WHERE td.organization_id=$1
      AND td.id=$2
      AND COALESCE(r.run_status, r.status) IN ('final','posted')
    LIMIT 1
    `,
    [orgId, tempDifferenceId]
  );
  return rows.length > 0;
}

async function createTempDifference({ orgId, actorUserId, payload }) {
  await assertPeriodExists({ orgId, periodId: payload.period_id });

  const { rows: cat } = await pool.query(
    `SELECT id FROM ias12_temp_difference_categories WHERE organization_id=$1 AND id=$2 AND status='active'`,
    [orgId, payload.category_id]
  );
  if (!cat.length) throw new AppError(400, "Invalid category_id");

  const { rows } = await pool.query(
    `
    INSERT INTO ias12_temp_differences(
      organization_id,
      period_id,
      category_id,
      source_type,
      source_id,
      diff_type,
      carrying_amount,
      tax_base,
      recognisable,
      notes,
      created_by,
      is_active
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)
    RETURNING id, period_id, category_id, source_type, source_id, diff_type, carrying_amount, tax_base, recognisable, notes, created_at, updated_at
    `,
    [
      orgId,
      payload.period_id,
      payload.category_id,
      payload.source_type || null,
      payload.source_id || null,
      payload.diff_type,
      payload.carrying_amount,
      payload.tax_base,
      payload.recognisable !== false,
      payload.notes || null,
      actorUserId || null,
    ]
  );
  return rows[0];
}

async function updateTempDifference({ orgId, actorUserId, tempDifferenceId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existing } = await client.query(
      `SELECT id, period_id, category_id, source_type, source_id, diff_type, carrying_amount, tax_base, recognisable, notes, COALESCE(is_active, TRUE) AS is_active
       FROM ias12_temp_differences
       WHERE organization_id=$1 AND id=$2`,
      [orgId, tempDifferenceId]
    );
    if (!existing.length) throw new AppError(404, "Temp difference not found");
    if (!existing[0].is_active) throw new AppError(409, "Temp difference is inactive");

  if (payload.category_id) {
    const { rows: cat } = await pool.query(
      `SELECT id FROM ias12_temp_difference_categories WHERE organization_id=$1 AND id=$2 AND status='active'`,
      [orgId, payload.category_id]
    );
    if (!cat.length) throw new AppError(400, "Invalid category_id");
  }

    if (payload.category_id) {
      const { rows: cat } = await client.query(
        `SELECT id FROM ias12_temp_difference_categories WHERE organization_id=$1 AND id=$2 AND status='active'`,
        [orgId, payload.category_id]
      );
      if (!cat.length) throw new AppError(400, "Invalid category_id");
    }

    const locked = await isTempDifferenceLocked(client, { orgId, tempDifferenceId });

    // If this temp difference has been used in a FINAL/POSTED run, preserve auditability by superseding it.
    if (locked) {
      const cur = existing[0];
      const next = {
        period_id: cur.period_id,
        category_id: payload.category_id || cur.category_id,
        source_type: payload.source_type === undefined ? cur.source_type : payload.source_type,
        source_id: payload.source_id === undefined ? cur.source_id : payload.source_id,
        diff_type: payload.diff_type || cur.diff_type,
        carrying_amount: payload.carrying_amount === undefined ? cur.carrying_amount : payload.carrying_amount,
        tax_base: payload.tax_base === undefined ? cur.tax_base : payload.tax_base,
        recognisable: payload.recognisable === undefined ? cur.recognisable : payload.recognisable,
        notes: payload.notes === undefined ? cur.notes : payload.notes,
      };

      const { rows: inserted } = await client.query(
        `
        INSERT INTO ias12_temp_differences(
          organization_id, period_id, category_id,
          source_type, source_id, diff_type,
          carrying_amount, tax_base, recognisable,
          notes, created_by, is_active
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)
        RETURNING id, period_id, category_id, source_type, source_id, diff_type, carrying_amount, tax_base, recognisable, notes, created_at, updated_at
        `,
        [
          orgId,
          next.period_id,
          next.category_id,
          next.source_type || null,
          next.source_id || null,
          next.diff_type,
          next.carrying_amount,
          next.tax_base,
          next.recognisable !== false,
          next.notes || null,
          actorUserId || null,
        ]
      );

      await client.query(
        `
        UPDATE ias12_temp_differences
        SET is_active=FALSE, superseded_at=NOW(), superseded_by=$3, superseded_reason='superseded'
        WHERE organization_id=$1 AND id=$2
        `,
        [orgId, tempDifferenceId, actorUserId || null]
      );

      await client.query("COMMIT");
      return { ...inserted[0], superseded: true };
    }

    const { rows } = await client.query(
      `
      UPDATE ias12_temp_differences
      SET
        category_id = COALESCE($3, category_id),
        source_type = COALESCE($4, source_type),
        source_id = COALESCE($5, source_id),
        diff_type = COALESCE($6, diff_type),
        carrying_amount = COALESCE($7, carrying_amount),
        tax_base = COALESCE($8, tax_base),
        recognisable = COALESCE($9, recognisable),
        notes = COALESCE($10, notes),
        updated_at = NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING id, period_id, category_id, source_type, source_id, diff_type, carrying_amount, tax_base, recognisable, notes, created_at, updated_at
      `,
      [
        orgId,
        tempDifferenceId,
        payload.category_id || null,
        payload.source_type === undefined ? null : payload.source_type,
        payload.source_id === undefined ? null : payload.source_id,
        payload.diff_type || null,
        payload.carrying_amount === undefined ? null : payload.carrying_amount,
        payload.tax_base === undefined ? null : payload.tax_base,
        payload.recognisable === undefined ? null : payload.recognisable,
        payload.notes === undefined ? null : payload.notes,
      ]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function deleteTempDifference({ orgId, actorUserId, tempDifferenceId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query(
      `SELECT id, COALESCE(is_active, TRUE) AS is_active FROM ias12_temp_differences WHERE organization_id=$1 AND id=$2`,
      [orgId, tempDifferenceId]
    );
    if (!existing.length) throw new AppError(404, "Temp difference not found");
    if (!existing[0].is_active) {
      await client.query("COMMIT");
      return { ok: true, idempotent: true };
    }

    const locked = await isTempDifferenceLocked(client, { orgId, tempDifferenceId });
    if (locked) {
      await client.query(
        `
        UPDATE ias12_temp_differences
        SET is_active=FALSE, superseded_at=NOW(), superseded_by=$3, superseded_reason='deleted'
        WHERE organization_id=$1 AND id=$2
        `,
        [orgId, tempDifferenceId, actorUserId || null]
      );
      await client.query("COMMIT");
      return { ok: true, soft_deleted: true };
    }

    const { rowCount } = await client.query(
      `DELETE FROM ias12_temp_differences WHERE organization_id=$1 AND id=$2`,
      [orgId, tempDifferenceId]
    );
    if (!rowCount) throw new AppError(404, "Temp difference not found");
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}
async function resolveEffectiveRate({ orgId, rateSetId, asOfDate }) {
  // Ensure rate set belongs to org and is active
  const { rows: rs } = await pool.query(
    `SELECT id, status FROM ias12_tax_rate_sets WHERE organization_id=$1 AND id=$2`,
    [orgId, rateSetId]
  );
  if (!rs.length) throw new AppError(400, "Invalid rate_set_id");
  if (rs[0].status !== "active") throw new AppError(409, "Rate set is inactive");

  // Convert to proper date object
  const queryDate = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  
  // Use date-only comparison (ignoring time)
  const dateStr = queryDate.toISOString().split('T')[0];
  
  const { rows } = await pool.query(
    `
    SELECT rate, effective_from, effective_to
    FROM ias12_tax_rate_lines
    WHERE rate_set_id=$1
      AND $2::date >= effective_from
      AND (effective_to IS NULL OR $2::date <= effective_to)
    ORDER BY effective_from DESC
    LIMIT 1
    `,
    [rateSetId, dateStr]
  );
  
  if (!rows.length) {
    // Try alternative logic - find the most recent rate that was in effect BEFORE the date
    const { rows: fallbackRows } = await pool.query(
      `
      SELECT rate, effective_from, effective_to
      FROM ias12_tax_rate_lines
      WHERE rate_set_id=$1
        AND effective_from <= $2::date
      ORDER BY effective_from DESC
      LIMIT 1
      `,
      [rateSetId, dateStr]
    );
    
    if (!fallbackRows.length) {
      throw new AppError(409, 
        `No tax rate found for ${dateStr}. The rate set doesn't cover this date. ` +
        `You may need to add a rate line for periods beyond ${new Date('2027-01-01').toISOString().split('T')[0]}`
      );
    }
    
    logger.warn({ fallback_effective_from: fallbackRows[0].effective_from, date: dateStr }, "IAS12: Using fallback exchange rate");
    return new Decimal(fallbackRows[0].rate);
  }
  
  return new Decimal(rows[0].rate);
}
async function getPriorPeriodId({ orgId, period }) {
  const { rows } = await pool.query(
    `
    SELECT id, start_date, end_date
    FROM accounting_periods
    WHERE organization_id=$1 AND end_date < $2
    ORDER BY end_date DESC
    LIMIT 1
    `,
    [orgId, period.start_date]
  );
  return rows[0] || null;
}

// --------------------------------------
// Imports / copy-forward / reports (Stage 3)
// --------------------------------------

async function importTempDifferences({ orgId, actorUserId, payload }) {
  await assertPeriodExists({ orgId, periodId: payload.period_id });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create import batch (for traceability)
    const batchRes = await client.query(
      `
      INSERT INTO ias12_temp_difference_import_batches(
        organization_id, period_id, source, filename, created_by
      )
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id, created_at
      `,
      [orgId, payload.period_id, payload.source || "manual_import", payload.filename || null, actorUserId]
    );
    const batchId = batchRes.rows[0].id;

    // Resolve category ids where category_code is provided
    const catByCode = new Map();
    const neededCodes = Array.from(
      new Set(payload.rows.map(r => (r.category_code || "").trim()).filter(Boolean))
    );
    if (neededCodes.length) {
      const { rows: cats } = await client.query(
        `
        SELECT id, code FROM ias12_temp_difference_categories
        WHERE organization_id=$1 AND code = ANY($2)
        `,
        [orgId, neededCodes]
      );
      for (const c of cats) catByCode.set(c.code, c.id);

      const missing = neededCodes.filter(c => !catByCode.has(c));
      if (missing.length) {
        throw new AppError(400, `Unknown category_code(s): ${missing.join(", ")}`);
      }
    }

    let inserted = 0;
    for (const r of payload.rows) {
      const categoryId = r.category_id || (r.category_code ? catByCode.get(r.category_code.trim()) : null);
      if (!categoryId) throw new AppError(400, "Each row must include category_id or category_code");

      await client.query(
        `
        INSERT INTO ias12_temp_differences(
          organization_id, period_id, category_id,
          source_type, source_id, diff_type,
          carrying_amount, tax_base, recognisable, notes,
          created_by, import_batch_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `,
        [
          orgId,
          payload.period_id,
          categoryId,
          r.source_type || null,
          r.source_id || null,
          r.diff_type,
          r.carrying_amount,
          r.tax_base,
          typeof r.recognisable === "boolean" ? r.recognisable : true,
          r.notes || null,
          actorUserId,
          batchId,
        ]
      );
      inserted += 1;
    }

    await client.query("COMMIT");
    return { import_batch_id: batchId, inserted, created_at: batchRes.rows[0].created_at };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function copyForwardTempDifferences({ orgId, actorUserId, payload }) {
  await assertPeriodExists({ orgId, periodId: payload.from_period_id });
  await assertPeriodExists({ orgId, periodId: payload.to_period_id });

  if (payload.from_period_id === payload.to_period_id) {
    throw new AppError(400, "from_period_id and to_period_id must differ");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (payload.overwrite) {
      await client.query(
        `DELETE FROM ias12_temp_differences WHERE organization_id=$1 AND period_id=$2`,
        [orgId, payload.to_period_id]
      );
    } else {
      const { rows } = await client.query(
        `SELECT 1 FROM ias12_temp_differences WHERE organization_id=$1 AND period_id=$2 LIMIT 1`,
        [orgId, payload.to_period_id]
      );
      if (rows.length) throw new AppError(409, "Temp differences already exist for to_period_id (use overwrite=true)");
    }

    const { rows: inserted } = await client.query(
      `
      INSERT INTO ias12_temp_differences(
        organization_id, period_id, category_id,
        source_type, source_id, diff_type,
        carrying_amount, tax_base, recognisable, notes, created_by
      )
      SELECT
        organization_id, $2, category_id,
        source_type, source_id, diff_type,
        carrying_amount, tax_base, recognisable, notes, $3
      FROM ias12_temp_differences
      WHERE organization_id=$1 AND period_id=$4
        AND COALESCE(is_active, TRUE) = TRUE
      RETURNING id
      `,
      [orgId, payload.to_period_id, actorUserId, payload.from_period_id]
    );

    await client.query("COMMIT");
    return { copied: inserted.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getRollForwardReport({ orgId, periodId }) {
  await assertPeriodExists({ orgId, periodId });

  const { rows } = await pool.query(
    `
    SELECT
      b.period_id,
      p.start_date,
      p.end_date,
      b.opening_dta,
      b.opening_dtl,
      b.movement_dta,
      b.movement_dtl,
      b.closing_dta,
      b.closing_dtl,
      b.deferred_tax_expense
    FROM ias12_deferred_tax_balances b
    JOIN accounting_periods p ON p.id=b.period_id
    WHERE b.organization_id=$1 AND b.period_id=$2
    `,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(404, "No deferred tax balances found for period (compute first)");
  return rows[0];
}

async function getCategoryBreakdownReport({ orgId, periodId }) {
  await assertPeriodExists({ orgId, periodId });

  // Use latest run for the period (prefer FINAL, else latest)
  const { rows: runRows } = await pool.query(
    `
    SELECT id, run_status, created_at
    FROM ias12_deferred_tax_runs
    WHERE organization_id=$1 AND period_id=$2
    ORDER BY (run_status='final') DESC, created_at DESC
    LIMIT 1
    `,
    [orgId, periodId]
  );
  if (!runRows.length) throw new AppError(404, "No deferred tax run found for period (compute first)");
  const runId = runRows[0].id;

  const { rows } = await pool.query(
    `
    SELECT
      c.code AS category_code,
      c.name AS category_name,
      SUM(CASE WHEN td.diff_type='DEDUCTIBLE' THEN r.computed_tax_amount ELSE 0 END) AS dta_amount,
      SUM(CASE WHEN td.diff_type='TAXABLE' THEN r.computed_tax_amount ELSE 0 END) AS dtl_amount,
      SUM(r.computed_tax_amount) AS total_amount
    FROM ias12_deferred_tax_run_lines r
    JOIN ias12_temp_differences td ON td.id = r.temp_difference_id
    JOIN ias12_temp_difference_categories c ON c.id = td.category_id
    WHERE r.run_id=$1
    GROUP BY c.code, c.name
    ORDER BY c.code
    `,
    [runId]
  );

  return { run_id: runId, run_status: runRows[0].run_status, categories: rows };
}

async function getUnrecognisedDtaReport({ orgId, periodId }) {
  await assertPeriodExists({ orgId, periodId });

  const { rows } = await pool.query(
    `
    SELECT
      td.id,
      td.category_id,
      c.code AS category_code,
      c.name AS category_name,
      td.diff_type,
      td.carrying_amount,
      td.tax_base,
      (td.carrying_amount - td.tax_base) AS difference,
      td.notes
    FROM ias12_temp_differences td
    JOIN ias12_temp_difference_categories c ON c.id = td.category_id
    WHERE td.organization_id=$1 AND td.period_id=$2
      AND COALESCE(td.is_active, TRUE) = TRUE
      AND td.diff_type='DEDUCTIBLE'
      AND td.recognisable = false
    ORDER BY c.code, td.id
    `,
    [orgId, periodId]
  );
  return { period_id: periodId, unrecognised_dtas: rows };
}

async function computeDeferredTax({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const period = await assertPeriodExists({ orgId, periodId: payload.period_id });

    // If the period already has an active posted deferred tax journal, require reversal first.
    const { rows: activePosting } = await client.query(
      `SELECT journal_id, status FROM ias12_deferred_tax_postings WHERE organization_id=$1 AND period_id=$2`,
      [orgId, payload.period_id]
    );
    if (activePosting.length && activePosting[0].journal_id && (activePosting[0].status || 'posted') === 'posted') {
      throw new AppError(409, "Deferred tax is already posted for this period. Reverse before recomputing.");
    }

    const settings = await getSettings({ orgId });
    const rateSetId = payload.rate_set_id || settings.default_rate_set_id;
    if (!rateSetId) throw new AppError(409, "No rate_set_id provided and no default_rate_set_id configured");

    const effectiveRate = await resolveEffectiveRate({ orgId, rateSetId, asOfDate: period.end_date });
    const rounding = settings.rounding_decimals ?? 2;

    const { rows: tds } = await client.query(
      `
      SELECT id, diff_type, carrying_amount, tax_base, recognisable
      FROM ias12_temp_differences
      WHERE organization_id=$1 AND period_id=$2
        AND COALESCE(is_active, TRUE) = TRUE
      ORDER BY created_at ASC
      `,
      [orgId, payload.period_id]
    );

  // Opening balances:
  // - If a reversal has been performed for this period, we still roll-forward from prior period.
  // - Otherwise, roll-forward from prior period.
  const prior = await getPriorPeriodId({ orgId, period });
  let openingDTA = new Decimal(0);
  let openingDTL = new Decimal(0);
  if (prior) {
    const { rows: b } = await client.query(
      `SELECT closing_dta, closing_dtl FROM ias12_deferred_tax_balances WHERE organization_id=$1 AND period_id=$2`,
      [orgId, prior.id]
    );
    if (b.length) {
      openingDTA = new Decimal(b[0].closing_dta || 0);
      openingDTL = new Decimal(b[0].closing_dtl || 0);
    }
  }

  let closingDTA = new Decimal(0);
  let closingDTL = new Decimal(0);

  // Build deterministic input hash for auditability
  const inputHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        period_id: payload.period_id,
        period_end: period.end_date,
        rate_set_id: rateSetId,
        effective_rate: effectiveRate.toFixed(6),
        rounding,
        temp_differences: tds.map((td) => ({
          id: td.id,
          diff_type: td.diff_type,
          carrying_amount: td.carrying_amount,
          tax_base: td.tax_base,
          recognisable: td.recognisable !== false,
        })),
      })
    )
    .digest("hex");

  const runId = (await client.query(
    `
    INSERT INTO ias12_deferred_tax_runs(
      organization_id, period_id, rate_set_id, effective_rate,
      status, run_status, run_type, input_hash, memo, created_by
    )
    VALUES ($1,$2,$3,$4,'computed','draft','original',$5,$6,$7)
    RETURNING id
    `,
    [
      orgId,
      payload.period_id,
      rateSetId,
      effectiveRate.toFixed(6),
      inputHash,
      payload.memo || null,
      actorUserId || null,
    ]
  )).rows[0].id;

  for (const td of tds) {
    const diff = new Decimal(td.carrying_amount || 0).minus(new Decimal(td.tax_base || 0)).abs();
    const recognisable = td.recognisable !== false;
    const taxAmt = recognisable ? diff.mul(effectiveRate) : new Decimal(0);
    const taxRounded = taxAmt.toDecimalPlaces(rounding, Decimal.ROUND_HALF_UP);

    if (td.diff_type === "DEDUCTIBLE") closingDTA = closingDTA.plus(taxRounded);
    else closingDTL = closingDTL.plus(taxRounded);

    await client.query(
      `
      INSERT INTO ias12_deferred_tax_run_lines(
        run_id, temp_difference_id, applied_rate, computed_tax_amount, diff_type, recognisable
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [runId, td.id, effectiveRate.toFixed(6), taxRounded.toFixed(rounding), td.diff_type, recognisable]
    );
  }

  const movementDTA = closingDTA.minus(openingDTA);
  const movementDTL = closingDTL.minus(openingDTL);
  const deferredTaxExpense = movementDTL.minus(movementDTA);

  await client.query(
    `
    INSERT INTO ias12_deferred_tax_balances(
      organization_id, period_id, run_id,
      opening_dta, opening_dtl, closing_dta, closing_dtl,
      movement_dta, movement_dtl, deferred_tax_expense
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (organization_id, period_id)
    DO UPDATE SET
      run_id = EXCLUDED.run_id,
      opening_dta = EXCLUDED.opening_dta,
      opening_dtl = EXCLUDED.opening_dtl,
      closing_dta = EXCLUDED.closing_dta,
      closing_dtl = EXCLUDED.closing_dtl,
      movement_dta = EXCLUDED.movement_dta,
      movement_dtl = EXCLUDED.movement_dtl,
      deferred_tax_expense = EXCLUDED.deferred_tax_expense,
      created_at = NOW()
    `,
    [
      orgId,
      payload.period_id,
      runId,
      openingDTA.toFixed(rounding),
      openingDTL.toFixed(rounding),
      closingDTA.toFixed(rounding),
      closingDTL.toFixed(rounding),
      movementDTA.toFixed(rounding),
      movementDTL.toFixed(rounding),
      deferredTaxExpense.toFixed(rounding),
    ]
  );

    await client.query("COMMIT");
    return {
      run_id: runId,
      period_id: payload.period_id,
      rate_set_id: rateSetId,
      effective_rate: effectiveRate.toFixed(6),
      opening: { dta: openingDTA.toFixed(rounding), dtl: openingDTL.toFixed(rounding) },
      closing: { dta: closingDTA.toFixed(rounding), dtl: closingDTL.toFixed(rounding) },
      movement: { dta: movementDTA.toFixed(rounding), dtl: movementDTL.toFixed(rounding) },
      deferred_tax_expense: deferredTaxExpense.toFixed(rounding),
    };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function finalizeDeferredTaxRun({ orgId, actorUserId, runId }) {
  const { rows } = await pool.query(
    `
    SELECT id, period_id, run_status
    FROM ias12_deferred_tax_runs
    WHERE organization_id=$1 AND id=$2
    `,
    [orgId, runId]
  );
  if (!rows.length) throw new AppError(404, "Run not found");

  if (rows[0].run_status === "posted") throw new AppError(409, "Run already posted");
  if (rows[0].run_status === "final") return { ok: true, run_id: runId, run_status: "final", idempotent: true };

  await pool.query(
    `
    UPDATE ias12_deferred_tax_runs
    SET run_status='final', finalized_at=NOW(), finalized_by=$3
    WHERE organization_id=$1 AND id=$2
    `,
    [orgId, runId, actorUserId || null]
  );

  return { ok: true, run_id: runId, run_status: "final" };
}

async function listDeferredTaxRuns({ orgId, periodId }) {
  const args = [orgId];
  let where = "organization_id=$1";
  if (periodId) {
    args.push(periodId);
    where += " AND period_id=$2";
  }
  const { rows } = await pool.query(
    `
    SELECT id AS run_id, period_id, rate_set_id, effective_rate,
           COALESCE(run_status, status) AS run_status,
           COALESCE(run_status, status) AS status,
           run_type, created_at, created_by, finalized_at, posted_at
    FROM ias12_deferred_tax_runs
    WHERE ${where}
    ORDER BY created_at DESC
    `,
    args
  );
  return rows;
}

async function getDeferredTaxRun({ orgId, runId }) {
  const { rows } = await pool.query(
    `
    SELECT id AS run_id, organization_id, period_id, rate_set_id, effective_rate,
           COALESCE(run_status, status) AS run_status,
           run_type, input_hash, memo,
           finalized_at, finalized_by,
           posted_at, posted_by,
           reversed_at, reversed_by, reverse_reason,
           created_at, created_by
    FROM ias12_deferred_tax_runs
    WHERE organization_id=$1 AND id=$2
    `,
    [orgId, runId]
  );
  if (!rows.length) throw new AppError(404, "Run not found");

  const { rows: bal } = await pool.query(
    `
    SELECT opening_dta, opening_dtl, closing_dta, closing_dtl, movement_dta, movement_dtl, deferred_tax_expense
    FROM ias12_deferred_tax_balances
    WHERE organization_id=$1 AND period_id=$2 AND run_id=$3
    `,
    [orgId, rows[0].period_id, runId]
  );

  const { rows: lines } = await pool.query(
    `
    SELECT
      rl.temp_difference_id,
      td.diff_type,
      td.carrying_amount,
      td.tax_base,
      (td.carrying_amount - td.tax_base) AS difference,
      rl.applied_rate,
      rl.computed_tax_amount,
      rl.recognisable
    FROM ias12_deferred_tax_run_lines rl
    JOIN ias12_temp_differences td ON td.id = rl.temp_difference_id
    WHERE rl.run_id=$1
    ORDER BY rl.created_at ASC
    `,
    [runId]
  );

  return { ...rows[0], balances: bal[0] || null, lines };
}

function buildMovementJournalLines({ movementDTA, movementDTL, settings }) {
  const lines = [];
  const dta = new Decimal(movementDTA || 0);
  const dtl = new Decimal(movementDTL || 0);

  const push = (accountId, debit, credit) => {
    const d = new Decimal(debit || 0);
    const c = new Decimal(credit || 0);

    if (d.gt(0) && c.gt(0)) {
      throw new Error(`Invalid journal line: both debit and credit > 0 for account ${accountId}`);
    }
    if (d.isZero() && c.isZero()) return;

    lines.push({
      accountId,
      debit: d.gt(0) ? d.toFixed(2) : "0.00",
      credit: c.gt(0) ? c.toFixed(2) : "0.00",
    });
  };

  // Balance sheet movements
  // DTA: + => Dr, - => Cr
  if (dta.gt(0)) push(settings.deferred_tax_asset_account_id, dta, 0);
  if (dta.lt(0)) push(settings.deferred_tax_asset_account_id, 0, dta.abs());

  // DTL: + => Cr, - => Dr
  if (dtl.gt(0)) push(settings.deferred_tax_liability_account_id, 0, dtl);
  if (dtl.lt(0)) push(settings.deferred_tax_liability_account_id, dtl.abs(), 0);

  // Net deferred tax expense movement (single-sided)
  // netExpense > 0 => Dr expense; netExpense < 0 => Cr expense
  const netExpense = dtl.minus(dta);
  if (netExpense.gt(0)) push(settings.deferred_tax_expense_account_id, netExpense, 0);
  if (netExpense.lt(0)) push(settings.deferred_tax_expense_account_id, 0, netExpense.abs());

  return lines;
}

async function postDeferredTax({ orgId, actorUserId, payload }) {
  const period = await assertPeriodExists({ orgId, periodId: payload.period_id });
  if (period.status !== "open") throw new AppError(409, "Period not open");

  const settings = await getSettings({ orgId });
  if (!settings.deferred_tax_asset_account_id || !settings.deferred_tax_liability_account_id || !settings.deferred_tax_expense_account_id) {
    throw new AppError(409, "IAS12 settings missing deferred tax accounts");
  }

  // Posting record:
  // - If journal_id exists => already posted
  // - If status=reversed and journal_id is NULL => allow re-post
  const { rows: postingRow } = await pool.query(
    `SELECT journal_id, prior_journal_id, reversal_journal_id, run_id, status, posted_at, reversed_at FROM ias12_deferred_tax_postings WHERE organization_id=$1 AND period_id=$2`,
    [orgId, payload.period_id]
  );
  if (postingRow.length && postingRow[0].journal_id) {
    return {
      ok: true,
      idempotent: true,
      journal_id: postingRow[0].journal_id,
      run_id: postingRow[0].run_id,
      posted_at: postingRow[0].posted_at,
    };
  }

  // Must have a deferred tax run to post.
  // Prefer explicit run_id; else post the latest FINAL run for period.
  let runId = payload.run_id || null;
  if (!runId) {
    const { rows: latestFinal } = await pool.query(
      `
      SELECT id
      FROM ias12_deferred_tax_runs
      WHERE organization_id=$1 AND period_id=$2 AND COALESCE(run_status, status)='final'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [orgId, payload.period_id]
    );
    if (!latestFinal.length) throw new AppError(409, "No FINAL deferred tax run found for period (finalize a run first)");
    runId = latestFinal[0].id;
  } else {
    const { rows: st } = await pool.query(
      `SELECT COALESCE(run_status, status) AS run_status FROM ias12_deferred_tax_runs WHERE organization_id=$1 AND id=$2`,
      [orgId, runId]
    );
    if (!st.length) throw new AppError(404, "Run not found");
    if (st[0].run_status !== "final") throw new AppError(409, "Run must be FINAL before posting");
  }

  const { rows: bal } = await pool.query(
    `
    SELECT run_id, movement_dta, movement_dtl, deferred_tax_expense
    FROM ias12_deferred_tax_balances
    WHERE organization_id=$1 AND period_id=$2 AND run_id=$3
    `,
    [orgId, payload.period_id, runId]
  );
  if (!bal.length) throw new AppError(409, "No deferred tax balances found for the run");

  const movementDTA = new Decimal(bal[0].movement_dta || 0);
  const movementDTL = new Decimal(bal[0].movement_dtl || 0);
  if (movementDTA.isZero() && movementDTL.isZero()) {
    return { ok: true, journal_id: null, run_id: bal[0].run_id, message: "No movement to post" };
  }

  const lines = buildMovementJournalLines({ movementDTA, movementDTL, settings });
  if (!lines.length) {
    return { ok: true, journal_id: null, run_id: bal[0].run_id, message: "No movement to post" };
  }

  const idempotencyKey = `IAS12:DT:${payload.period_id}:${runId}`;
  const memo = payload.memo || `IAS12 deferred tax movement (${period.start_date} to ${period.end_date})`;
  const postedJournal = await journalPosting.postJournal({
    orgId,
    actorUserId,
    payload: {
      typeCode: "GENERAL",
      periodId: payload.period_id,
      entryDate: period.end_date,
      memo,
      idempotencyKey,
      lines,
    },
  });

  // Upsert posting record. If this is a re-post after reversal, keep prior_journal_id.
  const journalId = postedJournal.journalId || postedJournal.id || postedJournal.journal_id;
  await pool.query(
    `
    INSERT INTO ias12_deferred_tax_postings(organization_id, period_id, run_id, journal_id, status, posted_by)
    VALUES ($1,$2,$3,$4,'posted',$5)
    ON CONFLICT (organization_id, period_id)
    DO UPDATE SET
      prior_journal_id = COALESCE(ias12_deferred_tax_postings.prior_journal_id, ias12_deferred_tax_postings.journal_id),
      journal_id = EXCLUDED.journal_id,
      run_id = EXCLUDED.run_id,
      status = 'posted',
      posted_at = NOW(),
      posted_by = EXCLUDED.posted_by
    `,
    [orgId, payload.period_id, runId, journalId, actorUserId || null]
  );

  await pool.query(
    `
    UPDATE ias12_deferred_tax_runs
    SET status='posted', run_status='posted', posted_at=NOW(), posted_by=$3
    WHERE organization_id=$1 AND id=$2
    `,
    [orgId, runId, actorUserId || null]
  );

  return { ok: true, journal_id: journalId, run_id: runId, idempotent: postedJournal.idempotent || false };
}

async function reverseDeferredTaxPosting({ orgId, actorUserId, payload }) {
  const period = await assertPeriodExists({ orgId, periodId: payload.period_id });
  if (period.status !== "open") throw new AppError(409, "Period not open");

  const { rows } = await pool.query(
    `SELECT journal_id, run_id, status FROM ias12_deferred_tax_postings WHERE organization_id=$1 AND period_id=$2`,
    [orgId, payload.period_id]
  );
  if (!rows.length || !rows[0].journal_id) throw new AppError(409, "No posted deferred tax journal to reverse");
  if (rows[0].status === "reversed") return { ok: true, idempotent: true, message: "Already reversed" };

  const targetPeriodId = payload.target_period_id || payload.period_id;
  const entryDate = payload.entry_date || period.end_date;
  const reason = payload.reason || "IAS12 deferred tax reversal";
  const idempotencyKey = `IAS12:DT:REV:${payload.period_id}:${rows[0].journal_id}`;

  const reversal = await journalPosting.reversePostedJournal({
    orgId,
    journalId: rows[0].journal_id,
    actorUserId,
    targetPeriodId,
    entryDate,
    reason,
    idempotencyKey,
  });

  const reversalJournalId = reversal.journalId || reversal.id || reversal.journal_id;

  // FIXED: Keep original journal_id, don't set it to placeholder
  await pool.query(
    `
    UPDATE ias12_deferred_tax_postings
    SET
      prior_journal_id = journal_id,           -- Store original as prior (optional)
      reversal_journal_id = $3,                -- Link to the reversal journal
      status = 'reversed',
      reversed_at = NOW(),
      reversed_by = $4,
      reverse_reason = $5
    WHERE organization_id=$1 AND period_id=$2
    `,
    [orgId, payload.period_id, reversalJournalId, actorUserId || null, reason]
  );

  await pool.query(
    `
    UPDATE ias12_deferred_tax_runs
    SET run_status='reversed', reversed_at=NOW(), reversed_by=$3, reverse_reason=$4
    WHERE organization_id=$1 AND id=$2
    `,
    [orgId, rows[0].run_id, actorUserId || null, reason]
  );

  return { ok: true, reversal_journal_id: reversalJournalId };
}

async function resolveRateForPeriodEnd({ orgId, periodId, rateSetId }) {
  const period = await assertPeriodExists({ orgId, periodId });
  const resolved = await resolveEffectiveRate({ orgId, rateSetId, asOfDate: period.end_date });
  return { period_end_date: period.end_date, rate: resolved.toFixed(6) };
}

module.exports = {
  listAuthorities,
  createAuthority,
  updateAuthority,
  listRateSets,
  createRateSet,
  listRateLines,
  addRateLine,
  getSettings,
  upsertSettings,
  listTempDifferenceCategories,
  createTempDifferenceCategory,
  listTempDifferences,
  createTempDifference,
  updateTempDifference,
  deleteTempDifference,
  importTempDifferences,
  copyForwardTempDifferences,
  getRollForwardReport,
  getCategoryBreakdownReport,
  getUnrecognisedDtaReport,
  resolveRateForPeriodEnd,
  computeDeferredTax,
  finalizeDeferredTaxRun,
  listDeferredTaxRuns,
  getDeferredTaxRun,
  postDeferredTax,
  reverseDeferredTaxPosting,
};