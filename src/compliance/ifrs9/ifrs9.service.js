
const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const Decimal = require("decimal.js");
const crypto = require("crypto");
const logger = require("../../config/logger");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const journalPosting = require("../../interfaces/journalPosting.interface");
const documentableSvc = require("../../workflow/documents/documentable.service");

// --------------------------------------
// Helpers
// --------------------------------------

function asNullableUuid(value) {
  return value || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function slugifyCode(value = "") {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || `IFRS9_${Date.now()}`;
}

function normalizeModelType(value) {
  if (!value) return "SIMPLIFIED";
  const upper = String(value).trim().toUpperCase();
  if (["SIMPLIFIED", "SIMPLIFIED_APPROACH"].includes(upper)) return "SIMPLIFIED";
  if (["GENERAL", "GENERAL_APPROACH"].includes(upper)) return "GENERAL";
  return upper;
}

function normalizeSettingsPayload(payload = {}) {
  const normalized = {};
  normalized.impairment_expense_account_id = asNullableUuid(
    payload.impairment_expense_account_id ?? payload.impairmentExpenseAccountId
  );
  normalized.loss_allowance_account_id = asNullableUuid(
    payload.loss_allowance_account_id ?? payload.allowance_account_id ?? payload.allowanceAccountId
  );
  normalized.default_model_id = asNullableUuid(payload.default_model_id ?? payload.defaultModelId);
  normalized.rounding_decimals = numberOrNull(payload.rounding_decimals ?? payload.roundingDecimals);
  normalized.stage2_threshold_days = numberOrNull(payload.stage2_threshold_days ?? payload.stage2_days_past_due ?? payload.stage2DaysPastDue);
  normalized.stage3_threshold_days = numberOrNull(payload.stage3_threshold_days ?? payload.stage3_days_past_due ?? payload.stage3DaysPastDue);
  normalized.default_lgd = numberOrNull(payload.default_lgd ?? payload.defaultLgd);
  normalized.annual_discount_rate = numberOrNull(payload.annual_discount_rate ?? payload.annualDiscountRate);
  normalized.model_change_approval_required = payload.model_change_approval_required ?? payload.modelChangeApprovalRequired ?? null;
  if (
    normalized.stage2_threshold_days !== null &&
    normalized.stage3_threshold_days !== null &&
    normalized.stage3_threshold_days < normalized.stage2_threshold_days
  ) {
    throw new AppError(400, "stage3_threshold_days must be greater than or equal to stage2_threshold_days");
  }
  return normalized;
}

function serializeSettings(row) {
  if (!row) return null;
  return {
    ...row,
    allowance_account_id: row.loss_allowance_account_id || null,
    stage2_days_past_due: row.stage2_threshold_days,
    stage3_days_past_due: row.stage3_threshold_days,
    model_change_approval_required: !!row.model_change_approval_required
  };
}

async function safeWriteAudit(payload) {
  try {
    await writeAudit(payload);
  } catch (error) {
    logger.warn({ err: error, action: payload?.action, entityType: payload?.entityType, entityId: payload?.entityId }, "IFRS9 audit write failed");
  }
}

async function getPeriodOrThrow(client, orgId, periodId) {
  const { rows } = await client.query(
    `SELECT id, code, status, start_date, end_date
     FROM accounting_periods
     WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(400, "Invalid period_id");
  return { ...rows[0], period_label: getPeriodLabel(rows[0]) };
}

async function getSettings(client, orgId) {
  const { rows } = await client.query(
    `SELECT * FROM ifrs9_settings WHERE organization_id=$1`,
    [orgId]
  );
  return rows[0] || null;
}

async function getSettingsOrThrow(client, orgId) {
  const s = await getSettings(client, orgId);
  if (!s) throw new AppError(409, "IFRS9 settings not configured");
  if (!s.impairment_expense_account_id || !s.loss_allowance_account_id) {
    throw new AppError(409, "IFRS9 settings missing posting accounts");
  }
  return s;
}

async function assertPostableAccount(client, orgId, accountId, label) {
  const { rows } = await client.query(
    `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, `Invalid ${label}`);
  if (!rows[0].is_postable) throw new AppError(400, `${label} is not postable`);
  if (rows[0].status !== "active") throw new AppError(400, `${label} is inactive`);
}

function parseAsOfDate(period, asOfDate) {
  if (asOfDate) {
    const d = new Date(asOfDate);
    if (Number.isNaN(d.getTime())) throw new AppError(400, "Invalid as_of_date");
    return asOfDate;
  }
  return period.end_date;
}


function getPeriodLabel(period) {
  if (!period) return null;
  return period.code || `${period.start_date} to ${period.end_date}`;
}

function buildModelSnapshot(model, buckets = [], params = []) {
  return {
    id: model.id,
    code: model.code,
    name: model.name,
    model_type: model.model_type,
    status: model.status,
    bucket_count: buckets.length,
    parameter_count: params.length,
    buckets: buckets.map((b) => ({
      id: b.id,
      label: b.label,
      days_past_due_from: Number(b.days_past_due_from),
      days_past_due_to: b.days_past_due_to === null || b.days_past_due_to === undefined ? null : Number(b.days_past_due_to),
      loss_rate: b.loss_rate === null || b.loss_rate === undefined ? null : Number(b.loss_rate)
    })),
    parameters: params.map((x) => ({
      id: x.id,
      stage: Number(x.stage),
      label: x.label,
      days_past_due_from: Number(x.days_past_due_from),
      days_past_due_to: x.days_past_due_to === null || x.days_past_due_to === undefined ? null : Number(x.days_past_due_to),
      pd_12m: Number(x.pd_12m),
      pd_lifetime: Number(x.pd_lifetime),
      lgd: x.lgd === null || x.lgd === undefined ? null : Number(x.lgd)
    }))
  };
}

function buildCoverageSummary(exposureRows = [], computedLines = []) {
  const invoiceExposureCount = exposureRows.filter((r) => r.source_type === "INVOICE").length;
  const contractAssetExposureCount = exposureRows.filter((r) => r.source_type === "CONTRACT_ASSET").length;
  const totalExposureCount = exposureRows.length;
  const stagedExposureCount = computedLines.reduce((sum, line) => sum + Number(line.invoice_count || 0) + Number(line.contract_asset_count || 0), 0);
  const unmatchedExposureCount = Math.max(0, totalExposureCount - stagedExposureCount);
  return {
    total_exposure_records: totalExposureCount,
    invoice_exposure_records: invoiceExposureCount,
    contract_asset_exposure_records: contractAssetExposureCount,
    staged_exposure_records: stagedExposureCount,
    unmatched_exposure_records: unmatchedExposureCount,
    unmatched_ratio: totalExposureCount ? Number((unmatchedExposureCount / totalExposureCount).toFixed(6)) : 0,
    line_count: computedLines.length
  };
}

function hashRunContent(runRow, lines) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ run: runRow, lines }))
    .digest("hex");
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

async function getActiveModelOrThrow(client, orgId, modelId) {
  const { rows } = await client.query(
    `SELECT id, code, name, model_type, status FROM ifrs9_ecl_models WHERE organization_id=$1 AND id=$2`,
    [orgId, modelId]
  );
  if (!rows.length) throw new AppError(400, "Invalid model_id");
  if (rows[0].status !== "active") throw new AppError(409, "ECL model is inactive");
  return rows[0];
}

async function listModelBuckets(client, modelId) {
  const { rows } = await client.query(
    `SELECT id, label, days_past_due_from, days_past_due_to, loss_rate
     FROM ifrs9_ecl_buckets
     WHERE model_id=$1
     ORDER BY days_past_due_from ASC`,
    [modelId]
  );
  return rows;
}

async function listModelParameters(client, orgId, modelId) {
  const { rows } = await client.query(
    `SELECT id, stage, label, days_past_due_from, days_past_due_to, pd_12m, pd_lifetime, lgd
     FROM ifrs9_ecl_parameters
     WHERE organization_id=$1 AND model_id=$2
     ORDER BY stage ASC, days_past_due_from ASC`,
    [orgId, modelId]
  );
  return rows;
}

function pickBucket(buckets, daysPastDue) {
  for (const b of buckets) {
    const from = Number(b.days_past_due_from);
    const to = b.days_past_due_to === null || b.days_past_due_to === undefined ? null : Number(b.days_past_due_to);
    if (daysPastDue >= from && (to === null || daysPastDue <= to)) return b;
  }
  return null;
}

function pickParameter(params, stage, daysPastDue) {
  for (const p of params) {
    if (Number(p.stage) !== Number(stage)) continue;
    const from = Number(p.days_past_due_from);
    const to = p.days_past_due_to === null || p.days_past_due_to === undefined ? null : Number(p.days_past_due_to);
    if (daysPastDue >= from && (to === null || daysPastDue <= to)) return p;
  }
  return null;
}

async function getCounterpartyStage(client, orgId, businessPartnerId, daysPastDue, settings) {
  const { rows } = await client.query(
    `SELECT stage_override, status
     FROM ifrs9_counterparty_profiles
     WHERE organization_id=$1 AND business_partner_id=$2`,
    [orgId, businessPartnerId]
  );
  if (rows.length && rows[0].status === "active" && rows[0].stage_override) {
    return Number(rows[0].stage_override);
  }

  const t2 = Number(settings.stage2_threshold_days ?? 30);
  const t3 = Number(settings.stage3_threshold_days ?? 90);
  if (daysPastDue >= t3) return 3;
  if (daysPastDue >= t2) return 2;
  return 1;
}

function roundMoney(dec, decimals) {
  return new Decimal(dec).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
}

async function sumPriorPostedEcl(client, orgId, periodEndDate) {
  const { rows } = await client.query(
    `SELECT r.total_ecl
     FROM ifrs9_ecl_runs r
     JOIN accounting_periods p ON p.id=r.period_id
     WHERE r.organization_id=$1
       AND r.status='posted'
       AND p.end_date < $2::date
     ORDER BY p.end_date DESC
     LIMIT 1`,
    [orgId, periodEndDate]
  );
  if (!rows.length) return new Decimal(0);
  return new Decimal(rows[0].total_ecl || 0);
}

function buildRunSummary(run) {
  return {
    id: run.id,
    organization_id: run.organization_id,
    period_id: run.period_id,
    model_id: run.model_id,
    period_code: run.period_code,
    period_label: run.period_label || getPeriodLabel(run),
    model_code: run.model_code,
    model_name: run.model_name,
    as_of_date: run.as_of_date,
    approach: run.approach,
    status: run.status,
    validation_status: run.validation_status || "passed",
    total_exposure: Number(run.total_exposure || 0),
    total_ecl: Number(run.total_ecl || 0),
    prior_posted_ecl: Number(run.prior_posted_ecl || 0),
    delta_allowance: Number(run.delta_allowance || 0),
    memo: run.memo,
    created_at: run.created_at,
    finalized_at: run.finalized_at,
    posted_at: run.posted_at,
    journal_entry_id: run.journal_entry_id,
    reversal_journal_entry_id: run.reversal_journal_entry_id,
    reversed_at: run.reversed_at,
    run_hash: run.run_hash || null,
    settings_snapshot: run.settings_snapshot || null,
    model_snapshot: run.model_snapshot || null,
    coverage_summary: run.coverage_summary || null,
    scenario_snapshot: run.scenario_snapshot || null,
    behavioral_snapshot: run.behavioral_snapshot || null
  };
}

// --------------------------------------
// Settings
// --------------------------------------

async function getIfrs9Settings({ orgId }) {
  const { rows } = await pool.query(`SELECT * FROM ifrs9_settings WHERE organization_id=$1`, [orgId]);
  return serializeSettings(rows[0] || null);
}

async function upsertIfrs9Settings({ orgId, actorUserId, payload, audit = {} }) {
  const client = await pool.connect();
  const normalized = normalizeSettingsPayload(payload);
  logger.debug({ keys: Object.keys(normalized || {}) }, "IFRS9: received settings payload");
  try {
    await client.query("BEGIN");
    const before = await getSettings(client, orgId);

    if (normalized.impairment_expense_account_id) {
      await assertPostableAccount(client, orgId, normalized.impairment_expense_account_id, "impairment_expense_account_id");
    }
    if (normalized.loss_allowance_account_id) {
      await assertPostableAccount(client, orgId, normalized.loss_allowance_account_id, "loss_allowance_account_id");
    }
    if (normalized.default_model_id) {
      await getActiveModelOrThrow(client, orgId, normalized.default_model_id);
    }

    const { rows } = await client.query(
      `INSERT INTO ifrs9_settings(
        organization_id,
        impairment_expense_account_id,
        loss_allowance_account_id,
        default_model_id,
        rounding_decimals,
        stage2_threshold_days,
        stage3_threshold_days,
        default_lgd,
        annual_discount_rate,
        model_change_approval_required,
        updated_by,
        updated_at,
        created_at
      )
      VALUES ($1,$2,$3,$4,COALESCE($5,2),COALESCE($6,30),COALESCE($7,90),COALESCE($8,0.45),COALESCE($9,0.10),COALESCE($10,FALSE),$11,NOW(),NOW())
      ON CONFLICT (organization_id)
      DO UPDATE SET
        impairment_expense_account_id=COALESCE(EXCLUDED.impairment_expense_account_id, ifrs9_settings.impairment_expense_account_id),
        loss_allowance_account_id=COALESCE(EXCLUDED.loss_allowance_account_id, ifrs9_settings.loss_allowance_account_id),
        default_model_id=COALESCE(EXCLUDED.default_model_id, ifrs9_settings.default_model_id),
        rounding_decimals=COALESCE(EXCLUDED.rounding_decimals, ifrs9_settings.rounding_decimals),
        stage2_threshold_days=COALESCE(EXCLUDED.stage2_threshold_days, ifrs9_settings.stage2_threshold_days),
        stage3_threshold_days=COALESCE(EXCLUDED.stage3_threshold_days, ifrs9_settings.stage3_threshold_days),
        default_lgd=COALESCE(EXCLUDED.default_lgd, ifrs9_settings.default_lgd),
        annual_discount_rate=COALESCE(EXCLUDED.annual_discount_rate, ifrs9_settings.annual_discount_rate),
        model_change_approval_required=COALESCE(EXCLUDED.model_change_approval_required, ifrs9_settings.model_change_approval_required),
        updated_by=EXCLUDED.updated_by,
        updated_at=NOW()
      RETURNING *`,
      [
        orgId,
        normalized.impairment_expense_account_id,
        normalized.loss_allowance_account_id,
        normalized.default_model_id,
        normalized.rounding_decimals,
        normalized.stage2_threshold_days,
        normalized.stage3_threshold_days,
        normalized.default_lgd,
        normalized.annual_discount_rate,
        normalized.model_change_approval_required,
        actorUserId
      ]
    );

    await client.query("COMMIT");
    const out = serializeSettings(rows[0]);
    await safeWriteAudit({
      organizationId: orgId,
      actorUserId,
      action: "ifrs9.settings.upsert",
      entityType: "ifrs9_settings",
      entityId: String(orgId),
      ip: audit.ip,
      userAgent: audit.userAgent,
      before: serializeSettings(before),
      after: out
    });
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// --------------------------------------
// ECL Models
// --------------------------------------

async function listEclModels({ orgId }) {
  const { rows } = await pool.query(
    `SELECT m.id, m.code, m.name, m.description, m.model_type, m.status, m.config_json, m.created_at, m.updated_at,
            COALESCE(b.bucket_count, 0) AS bucket_count,
            COALESCE(p.parameter_count, 0) AS parameter_count
     FROM ifrs9_ecl_models m
     LEFT JOIN (
       SELECT model_id, COUNT(*)::INT AS bucket_count
       FROM ifrs9_ecl_buckets
       GROUP BY model_id
     ) b ON b.model_id = m.id
     LEFT JOIN (
       SELECT model_id, COUNT(*)::INT AS parameter_count
       FROM ifrs9_ecl_parameters
       WHERE organization_id=$1
       GROUP BY model_id
     ) p ON p.model_id = m.id
     WHERE m.organization_id=$1
     ORDER BY m.code ASC`,
    [orgId]
  );
  return rows.map((row) => ({
    ...row,
    method: row.model_type,
    bucket_count: Number(row.bucket_count || 0),
    parameter_count: Number(row.parameter_count || 0)
  }));
}

async function createEclModel({ orgId, actorUserId, payload, audit = {} }) {
  const normalizedType = normalizeModelType(payload.model_type || payload.method);
  if (!["SIMPLIFIED", "GENERAL"].includes(normalizedType)) {
    throw new AppError(400, "model_type must be SIMPLIFIED or GENERAL");
  }
  const code = slugifyCode(payload.code || payload.name);
  const { rows } = await pool.query(
    `INSERT INTO ifrs9_ecl_models(
      organization_id, code, name, description, model_type, status, config_json, created_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW(),NOW()) RETURNING *`,
    [orgId, code, payload.name, payload.description || null, normalizedType, payload.status || "active", JSON.stringify(payload.config_json || payload.configJson || {}), actorUserId]
  );
  const out = { ...rows[0], method: rows[0].model_type, bucket_count: 0, parameter_count: 0 };
  await safeWriteAudit({
    organizationId: orgId,
    actorUserId,
    action: "ifrs9.model.create",
    entityType: "ifrs9_ecl_model",
    entityId: out.id,
    ip: audit.ip,
    userAgent: audit.userAgent,
    after: out
  });
  return out;
}

async function addEclParameter({ orgId, actorUserId, modelId, payload, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const model = await getActiveModelOrThrow(client, orgId, modelId);
    if (model.model_type !== "GENERAL") {
      throw new AppError(409, "Parameters can only be added to GENERAL models");
    }

    const daysFrom = Number(payload.days_past_due_from);
    const daysTo = payload.days_past_due_to === null || payload.days_past_due_to === undefined || payload.days_past_due_to === ""
      ? null
      : Number(payload.days_past_due_to);
    if (daysTo !== null && daysTo < daysFrom) {
      throw new AppError(400, "days_past_due_to must be >= days_past_due_from");
    }

    const { rows } = await client.query(
      `INSERT INTO ifrs9_ecl_parameters(
        organization_id, model_id, stage, label,
        days_past_due_from, days_past_due_to,
        pd_12m, pd_lifetime, lgd,
        created_by, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING *`,
      [
        orgId,
        model.id,
        Number(payload.stage),
        payload.label,
        daysFrom,
        daysTo,
        Number(payload.pd_12m),
        Number(payload.pd_lifetime),
        payload.lgd === null || payload.lgd === undefined || payload.lgd === "" ? null : Number(payload.lgd),
        actorUserId
      ]
    );
    await client.query("COMMIT");
    await safeWriteAudit({
      organizationId: orgId,
      actorUserId,
      action: "ifrs9.parameter.create",
      entityType: "ifrs9_ecl_parameter",
      entityId: rows[0].id,
      ip: audit.ip,
      userAgent: audit.userAgent,
      after: rows[0]
    });
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getCounterpartyProfile({ orgId, businessPartnerId }) {
  const { rows } = await pool.query(
    `SELECT * FROM ifrs9_counterparty_profiles WHERE organization_id=$1 AND business_partner_id=$2`,
    [orgId, businessPartnerId]
  );
  return rows[0] || null;
}

async function upsertCounterpartyProfile({ orgId, actorUserId, payload, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await getCounterpartyProfile({ orgId, businessPartnerId: payload.business_partner_id });
    const { rows: bpRows } = await client.query(
      `SELECT id FROM business_partners WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.business_partner_id]
    );
    if (!bpRows.length) throw new AppError(400, "Invalid business_partner_id");

    const { rows } = await client.query(
      `INSERT INTO ifrs9_counterparty_profiles(
        organization_id, business_partner_id, segment, stage_override, override_reason, status,
        updated_by, updated_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
      ON CONFLICT (organization_id, business_partner_id)
      DO UPDATE SET
        segment=COALESCE(EXCLUDED.segment, ifrs9_counterparty_profiles.segment),
        stage_override=EXCLUDED.stage_override,
        override_reason=COALESCE(EXCLUDED.override_reason, ifrs9_counterparty_profiles.override_reason),
        status=COALESCE(EXCLUDED.status, ifrs9_counterparty_profiles.status),
        updated_by=EXCLUDED.updated_by,
        updated_at=NOW()
      RETURNING *`,
      [
        orgId,
        payload.business_partner_id,
        payload.segment || null,
        payload.stage_override ?? null,
        payload.override_reason || null,
        payload.status || "active",
        actorUserId
      ]
    );

    await client.query("COMMIT");
    await safeWriteAudit({
      organizationId: orgId,
      actorUserId,
      action: "ifrs9.counterparty_profile.upsert",
      entityType: "ifrs9_counterparty_profile",
      entityId: rows[0].id,
      ip: audit.ip,
      userAgent: audit.userAgent,
      before,
      after: rows[0]
    });
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function addEclBucket({ orgId, actorUserId, modelId, payload, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const model = await getActiveModelOrThrow(client, orgId, modelId);
    if ((model.model_type || "SIMPLIFIED") !== "SIMPLIFIED") {
      throw new AppError(409, "Buckets can only be added to SIMPLIFIED models");
    }

    const label = payload.label || payload.name;
    const daysFrom = Number(payload.days_past_due_from);
    const daysTo = payload.days_past_due_to === null || payload.days_past_due_to === undefined || payload.days_past_due_to === ""
      ? null
      : Number(payload.days_past_due_to);
    const lossRate = numberOrNull(payload.loss_rate);

    if (!label) throw new AppError(400, "label is required");
    if (daysTo !== null && daysTo < daysFrom) {
      throw new AppError(400, "days_past_due_to must be >= days_past_due_from");
    }

    const { rows } = await client.query(
      `INSERT INTO ifrs9_ecl_buckets(
        model_id, label, days_past_due_from, days_past_due_to, loss_rate, created_by, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *`,
      [modelId, label, daysFrom, daysTo, lossRate, actorUserId]
    );
    await client.query("COMMIT");
    await safeWriteAudit({
      organizationId: orgId,
      actorUserId,
      action: "ifrs9.bucket.create",
      entityType: "ifrs9_ecl_bucket",
      entityId: rows[0].id,
      ip: audit.ip,
      userAgent: audit.userAgent,
      after: rows[0]
    });
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}


function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function getStateCode(daysPastDue, outstanding, settings) {
  if (Number(outstanding || 0) <= 0.005) return "RESOLVED";
  const t2 = Number(settings.stage2_threshold_days ?? 30);
  const t3 = Number(settings.stage3_threshold_days ?? 90);
  if (daysPastDue >= t3) return "DEFAULT";
  if (daysPastDue >= t2) return "SICR";
  return "CURRENT";
}

async function listCounterpartyProfilesMap(client, orgId) {
  const { rows } = await client.query(
    `SELECT business_partner_id, segment, stage_override, override_reason, status
     FROM ifrs9_counterparty_profiles
     WHERE organization_id=$1`,
    [orgId]
  );
  const map = new Map();
  for (const row of rows) map.set(row.business_partner_id, row);
  return map;
}

async function listActiveSicrTriggers(client, orgId, asOfDate) {
  const { rows } = await client.query(
    `SELECT *
     FROM ifrs9_sicr_qualitative_triggers
     WHERE organization_id=$1
       AND status='active'
       AND (valid_from IS NULL OR valid_from <= $2::date)
       AND (valid_to IS NULL OR valid_to >= $2::date)
     ORDER BY business_partner_id NULLS LAST, segment NULLS LAST, created_at ASC`,
    [orgId, asOfDate]
  );
  return rows;
}

async function listSelectedMacroScenarios(client, orgId, asOfDate, scenarioIds = []) {
  const params = [orgId, asOfDate];
  let where = `organization_id=$1 AND status='active' AND (effective_from IS NULL OR effective_from <= $2::date) AND (effective_to IS NULL OR effective_to >= $2::date)`;
  if (scenarioIds && scenarioIds.length) {
    params.push(scenarioIds);
    where += ` AND id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await client.query(
    `SELECT * FROM ifrs9_macro_scenarios WHERE ${where} ORDER BY scenario_type ASC, code ASC`,
    params
  );
  if (!rows.length) {
    return [{ id: null, code: 'BASE', name: 'Base', scenario_type: 'BASE', probability_weight: 1, variable_set: {}, neutral: true }];
  }
  const total = rows.reduce((sum, row) => sum + Number(row.probability_weight || 0), 0);
  if (total <= 0) throw new AppError(409, 'Active macro scenarios must have positive probability weights');
  return rows.map((row) => ({ ...row, normalized_weight: Number(row.probability_weight || 0) / total }));
}

async function listMacroOverlays(client, orgId, scenarioIds = []) {
  if (!scenarioIds.length) return [];
  const { rows } = await client.query(
    `SELECT *
     FROM ifrs9_macro_scenario_overlays
     WHERE organization_id=$1
       AND scenario_id = ANY($2::uuid[])
     ORDER BY created_at ASC`,
    [orgId, scenarioIds]
  );
  return rows;
}

function resolveScenarioOverlay({ overlays, scenarioId, modelId, segment, stage, daysPastDue }) {
  const relevant = overlays.filter((row) => {
    if (String(row.scenario_id) !== String(scenarioId)) return false;
    if (row.model_id && String(row.model_id) !== String(modelId)) return false;
    if (row.segment && String(row.segment) !== String(segment || '')) return false;
    if (row.stage !== null && row.stage !== undefined && Number(row.stage) !== Number(stage)) return false;
    if (row.days_past_due_from !== null && row.days_past_due_from !== undefined && Number(daysPastDue) < Number(row.days_past_due_from)) return false;
    if (row.days_past_due_to !== null && row.days_past_due_to !== undefined && Number(daysPastDue) > Number(row.days_past_due_to)) return false;
    return true;
  });
  const out = { pd_multiplier: 1, lgd_multiplier: 1, loss_rate_multiplier: 1, ecl_multiplier: 1, matched_overlay_ids: [] };
  for (const row of relevant) {
    out.pd_multiplier *= Number(row.pd_multiplier || 1);
    out.lgd_multiplier *= Number(row.lgd_multiplier || 1);
    out.loss_rate_multiplier *= Number(row.loss_rate_multiplier || 1);
    out.ecl_multiplier *= Number(row.ecl_multiplier || 1);
    out.matched_overlay_ids.push(row.id);
  }
  return out;
}

function resolveStageContext({ businessPartnerId, daysPastDue, settings, profile, triggers = [] }) {
  const reasons = [];
  const thresholdStage = daysPastDue >= Number(settings.stage3_threshold_days ?? 90)
    ? 3
    : daysPastDue >= Number(settings.stage2_threshold_days ?? 30)
      ? 2
      : 1;
  let stage = thresholdStage;
  reasons.push(`Threshold-based staging from ${daysPastDue} DPD`);

  const applicableTriggers = triggers.filter((t) => {
    if (t.business_partner_id && String(t.business_partner_id) !== String(businessPartnerId)) return false;
    if (t.segment && String(t.segment) !== String(profile?.segment || '')) return false;
    return true;
  });
  for (const trigger of applicableTriggers) {
    if (trigger.force_stage_min) {
      stage = Math.max(stage, Number(trigger.force_stage_min));
      reasons.push(`Qualitative SICR trigger: ${trigger.trigger_name}`);
    }
  }

  if (profile && profile.status === 'active' && profile.stage_override) {
    stage = Number(profile.stage_override);
    reasons.push(`Manual stage override (${profile.override_reason || 'profile'})`);
  }

  let pdMultiplier = 1;
  let lgdMultiplier = 1;
  for (const trigger of applicableTriggers) {
    pdMultiplier *= Number(trigger.pd_multiplier || 1);
    lgdMultiplier *= Number(trigger.lgd_multiplier || 1);
  }

  return {
    stage,
    reasons,
    trigger_codes: applicableTriggers.map((t) => t.trigger_code),
    pd_multiplier: pdMultiplier,
    lgd_multiplier: lgdMultiplier,
    segment: profile?.segment || null
  };
}

async function computeBehavioralAnalyticsEngine(client, orgId, actorUserId, { asOfDate, horizonMonths = 12, transitionWindowDays = 30, persistSnapshot = false }) {
  const { rows } = await client.query(
    `SELECT
        i.id,
        i.invoice_date,
        i.due_date,
        COALESCE(i.total, 0) AS total_amount,
        GREATEST(0, COALESCE(i.total, 0) - COALESCE(SUM(CASE WHEN r.status='posted' AND r.receipt_date <= $2::date THEN a.amount_applied ELSE 0 END), 0)) AS outstanding_as_of,
        GREATEST(0, COALESCE(i.total, 0) - COALESCE(SUM(CASE WHEN r.status='posted' AND r.receipt_date <= ($2::date - ($3::text || ' days')::interval) THEN a.amount_applied ELSE 0 END), 0)) AS outstanding_window_start
     FROM invoices i
     LEFT JOIN customer_receipt_allocations a ON a.invoice_id = i.id
     LEFT JOIN customer_receipts r ON r.id = a.customer_receipt_id AND r.organization_id = i.organization_id
     WHERE i.organization_id=$1
       AND i.invoice_date <= $2::date
       AND i.invoice_date >= ($2::date - ($4::text || ' months')::interval)
       AND i.due_date IS NOT NULL
       AND COALESCE(i.total, 0) > 0
     GROUP BY i.id, i.invoice_date, i.due_date, i.total`,
    [orgId, asOfDate, String(transitionWindowDays), String(horizonMonths)]
  );

  const cohorts = new Map();
  const matrix = new Map();
  let defaultStart = 0;
  let cured = 0;

  for (const row of rows) {
    const dpdEnd = Math.max(0, daysBetween(row.due_date, asOfDate));
    const startDate = new Date(new Date(asOfDate).getTime() - transitionWindowDays * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
    const dpdStart = Math.max(0, daysBetween(row.due_date, startDate));
    const startState = getStateCode(dpdStart, row.outstanding_window_start, { stage2_threshold_days: 30, stage3_threshold_days: 90 });
    const endState = getStateCode(dpdEnd, row.outstanding_as_of, { stage2_threshold_days: 30, stage3_threshold_days: 90 });
    const key = `${startState}->${endState}`;
    matrix.set(key, (matrix.get(key) || 0) + 1);
    if (startState === 'DEFAULT') {
      defaultStart += 1;
      if (endState === 'RESOLVED') cured += 1;
    }
    const cohort = String(row.invoice_date).slice(0, 7);
    const current = cohorts.get(cohort) || { total_amount: 0, default_amount: 0, invoice_count: 0 };
    current.total_amount += Number(row.total_amount || 0);
    current.invoice_count += 1;
    if (endState === 'DEFAULT') current.default_amount += Number(row.outstanding_as_of || 0);
    cohorts.set(cohort, current);
  }

  const cohortRows = Array.from(cohorts.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([cohort, agg]) => ({
    cohort,
    invoice_count: agg.invoice_count,
    total_amount: Number(agg.total_amount.toFixed(2)),
    default_amount: Number(agg.default_amount.toFixed(2)),
    default_ratio: agg.total_amount > 0 ? Number((agg.default_amount / agg.total_amount).toFixed(6)) : 0
  }));
  const longTermVintage = cohortRows.length ? cohortRows.reduce((s, r) => s + r.default_ratio, 0) / cohortRows.length : 0;
  const recentRows = cohortRows.slice(-3);
  const recentVintage = recentRows.length ? recentRows.reduce((s, r) => s + r.default_ratio, 0) / recentRows.length : longTermVintage;
  const vintageMultiplier = longTermVintage > 0 ? clampNumber(recentVintage / longTermVintage, 0.75, 1.5) : 1;

  const currentToDefault = Array.from(matrix.entries()).filter(([k]) => k === 'CURRENT->DEFAULT').reduce((s, [, v]) => s + v, 0);
  const sicrToDefault = Array.from(matrix.entries()).filter(([k]) => k === 'SICR->DEFAULT').reduce((s, [, v]) => s + v, 0);
  const currentToSicr = Array.from(matrix.entries()).filter(([k]) => k === 'CURRENT->SICR').reduce((s, [, v]) => s + v, 0);
  const transitionStress = rows.length ? (currentToDefault + sicrToDefault + (currentToSicr * 0.5)) / rows.length : 0;
  const transitionMultiplier = clampNumber(1 + (transitionStress - 0.10), 0.75, 1.5);
  const cureRate = defaultStart ? cured / defaultStart : 0;
  const lgdMultiplier = clampNumber(1 - (cureRate * 0.5), 0.5, 1.25);
  const lossRateMultiplier = clampNumber((vintageMultiplier + transitionMultiplier) / 2, 0.75, 1.5);

  const metrics = {
    generated_at: new Date().toISOString(),
    as_of_date: asOfDate,
    horizon_months: horizonMonths,
    transition_window_days: transitionWindowDays,
    cure_rate: Number(cureRate.toFixed(6)),
    vintage_multiplier: Number(vintageMultiplier.toFixed(6)),
    transition_multiplier: Number(transitionMultiplier.toFixed(6)),
    lgd_multiplier: Number(lgdMultiplier.toFixed(6)),
    loss_rate_multiplier: Number(lossRateMultiplier.toFixed(6)),
    cohorts: cohortRows,
    transition_matrix: Array.from(matrix.entries()).map(([transition, count]) => ({ transition, count }))
  };

  if (persistSnapshot) {
    const { rows: saved } = await client.query(
      `INSERT INTO ifrs9_behavioral_snapshots(
        organization_id, as_of_date, horizon_months, transition_window_days,
        cure_rate, vintage_multiplier, transition_multiplier, lgd_multiplier, loss_rate_multiplier,
        metrics, created_by, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,NOW()) RETURNING *`,
      [
        orgId,
        asOfDate,
        horizonMonths,
        transitionWindowDays,
        metrics.cure_rate,
        metrics.vintage_multiplier,
        metrics.transition_multiplier,
        metrics.lgd_multiplier,
        metrics.loss_rate_multiplier,
        JSON.stringify(metrics),
        actorUserId || null
      ]
    );
    return { ...saved[0], metrics };
  }
  return metrics;
}
async function getRunDetails({ orgId, runId }) {
  const { rows } = await pool.query(
    `SELECT r.*, p.code AS period_code, p.start_date, p.end_date, m.code AS model_code, m.name AS model_name
     FROM ifrs9_ecl_runs r
     LEFT JOIN accounting_periods p ON p.id = r.period_id
     LEFT JOIN ifrs9_ecl_models m ON m.id = r.model_id
     WHERE r.organization_id=$1 AND r.id=$2`,
    [orgId, runId]
  );
  if (!rows.length) throw new AppError(404, "Run not found");
  const run = buildRunSummary(rows[0]);

  const { rows: lines } = await pool.query(
    `SELECT l.*, bp.name AS customer_name
     FROM ifrs9_ecl_run_lines l
     LEFT JOIN business_partners bp ON bp.id=l.customer_id
     WHERE l.run_id=$1
     ORDER BY COALESCE(l.stage, 1) ASC, l.days_past_due_from ASC, l.bucket_label ASC`,
    [runId]
  );

  return {
    run,
    summary: {
      total_lines: lines.length,
      total_exposure: run.total_exposure,
      total_ecl: run.total_ecl,
      delta_allowance: run.delta_allowance,
      validation_status: run.validation_status,
      coverage_summary: run.coverage_summary || null,
      scenario_snapshot: run.scenario_snapshot || null,
      behavioral_snapshot: run.behavioral_snapshot || null
    },
    lines: lines.map((l) => ({
      ...l,
      exposure_amount: Number(l.exposure_amount || 0),
      ecl_amount: Number(l.ecl_amount || 0),
      loss_rate: l.loss_rate === null || l.loss_rate === undefined ? null : Number(l.loss_rate),
      pd_used: l.pd_used === null || l.pd_used === undefined ? null : Number(l.pd_used),
      lgd_used: l.lgd_used === null || l.lgd_used === undefined ? null : Number(l.lgd_used),
      ead_amount: l.ead_amount === null || l.ead_amount === undefined ? null : Number(l.ead_amount),
      source_mix: l.source_mix || null,
      stage_reason: l.stage_reason || null,
      scenario_effects: l.scenario_effects || null,
      behavioral_effects: l.behavioral_effects || null
    }))
  };
}
// --------------------------------------
// Runs
// --------------------------------------

async function computeEcl({ orgId, actorUserId, payload, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const period = await getPeriodOrThrow(client, orgId, payload.period_id);
    if (period.status !== "open") throw new AppError(409, "Period is not open");

    const settings = await getSettingsOrThrow(client, orgId);
    const modelId = payload.model_id || settings.default_model_id;
    if (!modelId) throw new AppError(409, "No default ECL model configured");
    const model = await getActiveModelOrThrow(client, orgId, modelId);

    const approach = normalizeModelType(payload.approach || model.model_type || "SIMPLIFIED");

    let buckets = [];
    let params = [];
    if (approach === "SIMPLIFIED") {
      buckets = await listModelBuckets(client, modelId);
      if (!buckets.length) throw new AppError(409, "ECL model has no buckets");
    } else {
      if (model.model_type !== "GENERAL") throw new AppError(409, "Selected model is not GENERAL");
      params = await listModelParameters(client, orgId, modelId);
      if (!params.length) throw new AppError(409, "GENERAL model has no parameters");
    }

    const asOfDate = parseAsOfDate(period, payload.as_of_date);
    if (new Date(asOfDate) < new Date(period.start_date) || new Date(asOfDate) > new Date(period.end_date)) {
      throw new AppError(400, "as_of_date must fall within the selected accounting period");
    }

    const { rows: existingRuns } = await client.query(
      `SELECT id, status
       FROM ifrs9_ecl_runs
       WHERE organization_id=$1
         AND period_id=$2
         AND model_id=$3
         AND as_of_date=$4::date
         AND status IN ('computed','finalized','posted')
       ORDER BY created_at DESC
       LIMIT 1`,
      [orgId, payload.period_id, model.id, asOfDate]
    );
    if (existingRuns.length) {
      throw new AppError(409, `An IFRS 9 run already exists for this period, model and as-of date (${existingRuns[0].status})`);
    }

    const profilesMap = await listCounterpartyProfilesMap(client, orgId);
    const sicrTriggers = await listActiveSicrTriggers(client, orgId, asOfDate);
    const selectedScenarios = await listSelectedMacroScenarios(client, orgId, asOfDate, payload.scenario_ids || []);
    const overlays = await listMacroOverlays(client, orgId, selectedScenarios.map((s) => s.id).filter(Boolean));
    let behavioralSnapshot = null;
    if (payload.use_behavioral_metrics !== false) {
      if (payload.behavioral_snapshot_id) {
        const { rows } = await client.query(`SELECT * FROM ifrs9_behavioral_snapshots WHERE organization_id=$1 AND id=$2`, [orgId, payload.behavioral_snapshot_id]);
        if (!rows.length) throw new AppError(404, 'Behavioral snapshot not found');
        behavioralSnapshot = { ...(rows[0].metrics || {}), id: rows[0].id };
      } else {
        behavioralSnapshot = await computeBehavioralAnalyticsEngine(client, orgId, actorUserId, { asOfDate, horizonMonths: 12, transitionWindowDays: 30, persistSnapshot: false });
      }
    }

    const { rows: invRows } = await client.query(
      `SELECT
        i.id,
        i.customer_id,
        i.invoice_no AS doc_no,
        i.invoice_date AS doc_date,
        i.due_date,
        GREATEST(0, COALESCE(i.total, 0) - COALESCE(SUM(a.amount_applied) FILTER (WHERE r.status = 'posted'), 0)) AS amount,
        'INVOICE'::text AS source_type
      FROM invoices i
      LEFT JOIN customer_receipt_allocations a ON a.invoice_id = i.id
      LEFT JOIN customer_receipts r ON r.id = a.customer_receipt_id AND r.organization_id = i.organization_id AND r.receipt_date <= $2::date
      WHERE i.organization_id=$1 AND i.status='issued' AND i.invoice_date <= $2::date
      GROUP BY i.id, i.customer_id, i.invoice_no, i.invoice_date, i.due_date, i.total
      HAVING GREATEST(0, COALESCE(i.total, 0) - COALESCE(SUM(a.amount_applied) FILTER (WHERE r.status = 'posted'), 0)) > 0`,
      [orgId, asOfDate]
    );

    const { rows: caRows } = await client.query(
      `SELECT
        l.id,
        c.business_partner_id AS customer_id,
        c.code AS doc_no,
        l.recognition_date AS doc_date,
        l.recognition_date AS due_date,
        l.recognized_amount AS amount,
        'CONTRACT_ASSET'::text AS source_type
      FROM ifrs15_recognition_schedule_lines l
      JOIN ifrs15_contracts c ON c.id = l.contract_id
      WHERE l.organization_id=$1
        AND l.status='posted'
        AND l.recognition_date <= $2::date
        AND c.business_partner_id IS NOT NULL
        AND c.status IN ('active','completed')
        AND c.billing_policy IN ('AS_RECOGNIZED','NONE')`,
      [orgId, asOfDate]
    );

    const exposureRows = [...invRows, ...caRows];
    const rounding = settings.rounding_decimals ?? 2;
    const lines = new Map();
    const customerMaxDaysPastDue = new Map();

    for (const ex of exposureRows) {
      if (!ex.customer_id) continue;
      const exposureDaysPastDue = Math.max(0, daysBetween(ex.due_date, asOfDate));
      customerMaxDaysPastDue.set(ex.customer_id, Math.max(exposureDaysPastDue, customerMaxDaysPastDue.get(ex.customer_id) || 0));
    }

    for (const ex of exposureRows) {
      if (!ex.customer_id) continue;
      const daysPastDue = Math.max(0, daysBetween(ex.due_date, asOfDate));
      const profile = profilesMap.get(ex.customer_id) || null;
      const stageCtx = resolveStageContext({
        businessPartnerId: ex.customer_id,
        daysPastDue: customerMaxDaysPastDue.get(ex.customer_id) || daysPastDue,
        settings,
        profile,
        triggers: sicrTriggers
      });

      if (approach === 'SIMPLIFIED') {
        const bucket = pickBucket(buckets, daysPastDue);
        if (!bucket) continue;
        const key = `${ex.customer_id}:${bucket.id}:S:${stageCtx.segment || 'NONE'}`;
        if (!lines.has(key)) {
          lines.set(key, {
            customer_id: ex.customer_id,
            bucket_id: bucket.id,
            bucket_label: bucket.label,
            days_past_due_from: bucket.days_past_due_from,
            days_past_due_to: bucket.days_past_due_to,
            loss_rate: bucket.loss_rate,
            stage: stageCtx.stage,
            pd_used: null,
            lgd_used: null,
            param_id: null,
            segment: stageCtx.segment,
            trigger_codes: stageCtx.trigger_codes,
            invoice_count: 0,
            contract_asset_count: 0,
            exposure: new Decimal(0),
            stage_reason: stageCtx.reasons.join('; ')
          });
        }
        const agg = lines.get(key);
        if (ex.source_type === 'INVOICE') agg.invoice_count += 1;
        if (ex.source_type === 'CONTRACT_ASSET') agg.contract_asset_count += 1;
        agg.exposure = agg.exposure.plus(new Decimal(ex.amount || 0));
      } else {
        const p = pickParameter(params, stageCtx.stage, daysPastDue);
        if (!p) continue;
        const key = `${ex.customer_id}:${p.id}:${stageCtx.stage}:${stageCtx.segment || 'NONE'}`;
        if (!lines.has(key)) {
          lines.set(key, {
            customer_id: ex.customer_id,
            bucket_id: null,
            bucket_label: p.label,
            days_past_due_from: p.days_past_due_from,
            days_past_due_to: p.days_past_due_to,
            loss_rate: null,
            stage: stageCtx.stage,
            pd_used: null,
            lgd_used: null,
            param_id: p.id,
            segment: stageCtx.segment,
            trigger_codes: stageCtx.trigger_codes,
            sicr_pd_multiplier: stageCtx.pd_multiplier,
            sicr_lgd_multiplier: stageCtx.lgd_multiplier,
            invoice_count: 0,
            contract_asset_count: 0,
            exposure: new Decimal(0),
            stage_reason: stageCtx.reasons.join('; ')
          });
        }
        const agg = lines.get(key);
        if (ex.source_type === 'INVOICE') agg.invoice_count += 1;
        if (ex.source_type === 'CONTRACT_ASSET') agg.contract_asset_count += 1;
        agg.exposure = agg.exposure.plus(new Decimal(ex.amount || 0));
      }
    }

    const runId = crypto.randomUUID();
    let totalExposure = new Decimal(0);
    let totalEcl = new Decimal(0);
    const priorEcl = await sumPriorPostedEcl(client, orgId, period.end_date);

    const computedLines = Array.from(lines.values()).map((l) => {
      const exposure = roundMoney(l.exposure, rounding);
      const scenarioBreakdown = [];
      let weightedEcl = new Decimal(0);
      let weightedPd = null;
      let weightedLgd = null;
      let behavioralEffects = behavioralSnapshot ? {
        vintage_multiplier: Number(behavioralSnapshot.vintage_multiplier || 1),
        transition_multiplier: Number(behavioralSnapshot.transition_multiplier || 1),
        lgd_multiplier: Number(behavioralSnapshot.lgd_multiplier || 1),
        loss_rate_multiplier: Number(behavioralSnapshot.loss_rate_multiplier || 1),
        cure_rate: Number(behavioralSnapshot.cure_rate || 0)
      } : null;

      for (const scenario of selectedScenarios) {
        const overlay = scenario.neutral ? { pd_multiplier: 1, lgd_multiplier: 1, loss_rate_multiplier: 1, ecl_multiplier: 1, matched_overlay_ids: [] } : resolveScenarioOverlay({
          overlays,
          scenarioId: scenario.id,
          modelId: model.id,
          segment: l.segment,
          stage: l.stage,
          daysPastDue: l.days_past_due_from || 0
        });
        const weight = Number(scenario.normalized_weight || scenario.probability_weight || 1);
        if (approach === 'SIMPLIFIED') {
          const baseLossRate = new Decimal(l.loss_rate || 0);
          const scenarioLossRate = baseLossRate
            .mul(new Decimal(overlay.loss_rate_multiplier || 1))
            .mul(new Decimal(behavioralSnapshot?.loss_rate_multiplier || 1))
            .mul(new Decimal(overlay.ecl_multiplier || 1));
          const scenarioEcl = roundMoney(exposure.mul(scenarioLossRate), rounding);
          weightedEcl = weightedEcl.plus(scenarioEcl.mul(weight));
          scenarioBreakdown.push({
            scenario_id: scenario.id,
            code: scenario.code,
            weight,
            loss_rate_used: Number(scenarioLossRate.toDecimalPlaces(6).toString()),
            ecl_amount: scenarioEcl.toNumber(),
            overlay_ids: overlay.matched_overlay_ids
          });
        } else {
          const p = params.find((x) => x.id === l.param_id);
          const basePd = l.stage === 1 ? new Decimal(p.pd_12m) : new Decimal(p.pd_lifetime);
          const baseLgd = p.lgd === null || p.lgd === undefined ? new Decimal(settings.default_lgd ?? 0.45) : new Decimal(p.lgd);
          const scenarioPd = basePd
            .mul(new Decimal(l.sicr_pd_multiplier || 1))
            .mul(new Decimal(behavioralSnapshot ? ((Number(behavioralSnapshot.vintage_multiplier || 1) + Number(behavioralSnapshot.transition_multiplier || 1)) / 2) : 1))
            .mul(new Decimal(overlay.pd_multiplier || 1));
          const scenarioLgd = baseLgd
            .mul(new Decimal(l.sicr_lgd_multiplier || 1))
            .mul(new Decimal(behavioralSnapshot?.lgd_multiplier || 1))
            .mul(new Decimal(overlay.lgd_multiplier || 1));
          const scenarioEcl = roundMoney(exposure.mul(scenarioPd).mul(scenarioLgd).mul(new Decimal(overlay.ecl_multiplier || 1)), rounding);
          weightedEcl = weightedEcl.plus(scenarioEcl.mul(weight));
          weightedPd = (weightedPd || new Decimal(0)).plus(scenarioPd.mul(weight));
          weightedLgd = (weightedLgd || new Decimal(0)).plus(scenarioLgd.mul(weight));
          scenarioBreakdown.push({
            scenario_id: scenario.id,
            code: scenario.code,
            weight,
            pd_used: Number(scenarioPd.toDecimalPlaces(6).toString()),
            lgd_used: Number(scenarioLgd.toDecimalPlaces(6).toString()),
            ecl_amount: scenarioEcl.toNumber(),
            overlay_ids: overlay.matched_overlay_ids
          });
        }
      }

      const ecl = roundMoney(weightedEcl, rounding);
      totalExposure = totalExposure.plus(exposure);
      totalEcl = totalEcl.plus(ecl);
      return {
        ...l,
        exposure_amount: exposure,
        ecl_amount: ecl,
        pd_used: weightedPd ? Number(weightedPd.toDecimalPlaces(6).toString()) : null,
        lgd_used: weightedLgd ? Number(weightedLgd.toDecimalPlaces(6).toString()) : null,
        ead_amount: approach === 'GENERAL' ? exposure.toNumber() : null,
        stage_reason: l.stage_reason || (approach === 'GENERAL' ? `Stage ${Number(l.stage)} derived from threshold, override and qualitative SICR logic` : 'Simplified approach loss-rate bucket'),
        source_mix: { invoices: Number(l.invoice_count || 0), contract_assets: Number(l.contract_asset_count || 0) },
        scenario_effects: { scenarios: scenarioBreakdown, scenario_count: scenarioBreakdown.length },
        behavioral_effects: behavioralEffects
      };
    });

    totalExposure = roundMoney(totalExposure, rounding);
    totalEcl = roundMoney(totalEcl, rounding);
    const deltaAllowance = roundMoney(totalEcl.minus(priorEcl), rounding);
    const coverageSummary = buildCoverageSummary(exposureRows, computedLines);
    const settingsSnapshot = {
      rounding_decimals: Number(settings.rounding_decimals ?? 2),
      stage2_threshold_days: Number(settings.stage2_threshold_days ?? 30),
      stage3_threshold_days: Number(settings.stage3_threshold_days ?? 90),
      default_lgd: Number(settings.default_lgd ?? 0.45),
      annual_discount_rate: Number(settings.annual_discount_rate ?? 0.10),
      impairment_expense_account_id: settings.impairment_expense_account_id || null,
      loss_allowance_account_id: settings.loss_allowance_account_id || null,
      model_change_approval_required: !!settings.model_change_approval_required
    };
    const modelSnapshot = buildModelSnapshot(model, buckets, params);
    const validationStatus = coverageSummary.unmatched_exposure_records > 0 ? 'warning' : 'passed';
    const scenarioSnapshot = selectedScenarios.map((s) => ({ id: s.id, code: s.code, name: s.name, weight: Number(s.normalized_weight || s.probability_weight || 1), type: s.scenario_type || 'BASE' }));

    await client.query(
      `INSERT INTO ifrs9_ecl_runs(
        id, organization_id, period_id, model_id, as_of_date, status,
        approach,
        total_exposure, total_ecl, prior_posted_ecl, delta_allowance,
        memo, created_by, created_at, updated_at,
        validation_status, settings_snapshot, model_snapshot, coverage_summary, scenario_snapshot, behavioral_snapshot
      ) VALUES ($1,$2,$3,$4,$5,'computed',$6,$7,$8,$9,$10,$11,$12,NOW(),NOW(),$13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb)`,
      [
        runId,
        orgId,
        payload.period_id,
        model.id,
        asOfDate,
        approach,
        totalExposure.toNumber(),
        totalEcl.toNumber(),
        priorEcl.toNumber(),
        deltaAllowance.toNumber(),
        payload.memo || null,
        actorUserId,
        validationStatus,
        JSON.stringify(settingsSnapshot),
        JSON.stringify(modelSnapshot),
        JSON.stringify(coverageSummary),
        JSON.stringify(scenarioSnapshot),
        JSON.stringify(behavioralSnapshot || null)
      ]
    );

    for (const l of computedLines) {
      await client.query(
        `INSERT INTO ifrs9_ecl_run_lines(
          run_id, customer_id, bucket_id, bucket_label,
          days_past_due_from, days_past_due_to, loss_rate,
          invoice_count, contract_asset_count, exposure_amount, ecl_amount,
          stage, pd_used, lgd_used, ead_amount, stage_reason, source_mix,
          scenario_effects, behavioral_effects
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb)`,
        [
          runId,
          l.customer_id,
          l.bucket_id,
          l.bucket_label,
          l.days_past_due_from,
          l.days_past_due_to,
          l.loss_rate,
          l.invoice_count,
          l.contract_asset_count || 0,
          l.exposure_amount.toNumber(),
          l.ecl_amount.toNumber(),
          l.stage,
          l.pd_used,
          l.lgd_used,
          l.ead_amount,
          l.stage_reason,
          JSON.stringify(l.source_mix || null),
          JSON.stringify(l.scenario_effects || null),
          JSON.stringify(l.behavioral_effects || null)
        ]
      );
    }

    const runHash = hashRunContent({
      id: runId,
      organization_id: orgId,
      period_id: payload.period_id,
      model_id: model.id,
      as_of_date: asOfDate,
      approach,
      total_exposure: totalExposure.toNumber(),
      total_ecl: totalEcl.toNumber(),
      prior_posted_ecl: priorEcl.toNumber(),
      delta_allowance: deltaAllowance.toNumber(),
      validation_status: validationStatus,
      coverage_summary: coverageSummary,
      scenario_snapshot: scenarioSnapshot,
      behavioral_snapshot: behavioralSnapshot || null
    }, computedLines.map((l) => ({
      customer_id: l.customer_id,
      bucket_id: l.bucket_id,
      param_id: l.param_id,
      stage: l.stage,
      exposure_amount: l.exposure_amount.toNumber(),
      ecl_amount: l.ecl_amount.toNumber(),
      stage_reason: l.stage_reason,
      source_mix: l.source_mix,
      scenario_effects: l.scenario_effects,
      behavioral_effects: l.behavioral_effects
    })));

    await client.query(`UPDATE ifrs9_ecl_runs SET run_hash=$3 WHERE organization_id=$1 AND id=$2`, [orgId, runId, runHash]);

    await client.query('COMMIT');
    const out = await getRunDetails({ orgId, runId });
    await safeWriteAudit({ organizationId: orgId, actorUserId, action: 'ifrs9.run.compute', entityType: 'ifrs9_ecl_run', entityId: runId, ip: audit.ip, userAgent: audit.userAgent, after: out.run });
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listRuns({ orgId, periodId }) {
  const params = [orgId];
  let where = `r.organization_id=$1`;
  if (periodId) {
    params.push(periodId);
    where += ` AND r.period_id=$${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT r.*, p.code AS period_code, p.start_date, p.end_date, m.code AS model_code, m.name AS model_name
     FROM ifrs9_ecl_runs r
     LEFT JOIN accounting_periods p ON p.id = r.period_id
     LEFT JOIN ifrs9_ecl_models m ON m.id = r.model_id
     WHERE ${where}
     ORDER BY COALESCE(r.as_of_date, p.end_date) DESC, r.created_at DESC`,
    params
  );
  return rows.map(buildRunSummary);
}

async function finalizeRun({ orgId, actorUserId, runId, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, status FROM ifrs9_ecl_runs WHERE organization_id=$1 AND id=$2`,
      [orgId, runId]
    );
    if (!rows.length) throw new AppError(404, "Run not found");
    if (rows[0].status !== "computed") throw new AppError(409, "Only computed runs can be finalized");

    const { rows: upd } = await client.query(
      `UPDATE ifrs9_ecl_runs SET status='finalized', finalized_by=$3, finalized_at=NOW(), updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, runId, actorUserId]
    );
    if (!upd[0].run_hash) {
      const { rows: lineRows } = await client.query(
        `SELECT customer_id, bucket_id, bucket_label, stage, exposure_amount, ecl_amount, stage_reason, source_mix
         FROM ifrs9_ecl_run_lines WHERE run_id=$1 ORDER BY id ASC`,
        [runId]
      );
      const frozenHash = hashRunContent(upd[0], lineRows);
      await client.query(
        `UPDATE ifrs9_ecl_runs SET run_hash=$3 WHERE organization_id=$1 AND id=$2`,
        [orgId, runId, frozenHash]
      );
    }
    await client.query("COMMIT");
    const out = await getRunDetails({ orgId, runId });
    await safeWriteAudit({
      organizationId: orgId,
      actorUserId,
      action: "ifrs9.run.finalize",
      entityType: "ifrs9_ecl_run",
      entityId: runId,
      ip: audit.ip,
      userAgent: audit.userAgent,
      after: out.run
    });
    return out.run;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function postEcl({ orgId, actorUserId, payload, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const period = await getPeriodOrThrow(client, orgId, payload.period_id);
    if (period.status !== "open") throw new AppError(409, "Period is not open");

    const settings = await getSettingsOrThrow(client, orgId);

    const { rows: runRows } = await client.query(
      `SELECT * FROM ifrs9_ecl_runs WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.run_id]
    );
    if (!runRows.length) throw new AppError(404, "Run not found");
    const run = runRows[0];
    if (run.status !== "finalized" && run.status !== "posted") {
      throw new AppError(409, "Run must be finalized before posting");
    }

    if (run.status === "posted") {
      await client.query("COMMIT");
      return { run_id: run.id, journal_id: run.journal_entry_id, already_posted: true };
    }

    const rounding = settings.rounding_decimals ?? 2;
    const delta = roundMoney(new Decimal(run.delta_allowance || 0), rounding);
    if (delta.isZero()) {
      const { rows: upd } = await client.query(
        `UPDATE ifrs9_ecl_runs SET status='posted', posted_at=NOW(), posted_by=$3, updated_at=NOW()
         WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [orgId, run.id, actorUserId]
      );
      await client.query("COMMIT");
      await safeWriteAudit({
        organizationId: orgId,
        actorUserId,
        action: "ifrs9.run.post",
        entityType: "ifrs9_ecl_run",
        entityId: run.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        after: { ...upd[0], no_entry: true }
      });
      return { run_id: upd[0].id, journal_id: null, already_posted: false, no_entry: true };
    }

    const debitExpense = delta.greaterThan(0);
    const amt = delta.abs();
    const entryDate = payload.entry_date || payload.posting_date || period.end_date;
    const idempotencyKey = `IFRS9:ECL:RUN:${run.id}:PERIOD:${payload.period_id}:POST`;

    const journalPayload = {
      periodId: payload.period_id,
      entryDate,
      typeCode: "GENERAL",
      memo: payload.memo || `IFRS9 ECL impairment (Run ${run.id})`,
      idempotencyKey,
      lines: [
        {
          accountId: settings.impairment_expense_account_id,
          debit: debitExpense ? amt.toNumber() : 0,
          credit: debitExpense ? 0 : amt.toNumber(),
          description: "IFRS9 impairment expense (delta)"
        },
        {
          accountId: settings.loss_allowance_account_id,
          debit: debitExpense ? 0 : amt.toNumber(),
          credit: debitExpense ? amt.toNumber() : 0,
          description: "IFRS9 loss allowance (delta)"
        }
      ]
    };

    const draft = await journalPosting.createDraftJournal({ orgId, actorUserId, payload: journalPayload, client });
    let posted;
    try {
      posted = await journalPosting.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client });
    } catch (err) {
      const msg = String(err?.message || "");
      const needsWorkflow =
        msg.includes("missing workflow document") ||
        msg.includes("requires approval before post");
      if (!needsWorkflow) throw err;

      // Journal workflow is enabled for this organization. Create and route the
      // generated journal through the normal journal approval lifecycle before posting.
      await journalPosting.submitDraftJournal({ orgId, journalId: draft.journalId, actorUserId });
      await journalPosting.approveSubmittedJournal({ orgId, journalId: draft.journalId, actorUserId: String(actorUserId) });
      posted = await journalPosting.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId: String(actorUserId), client });
    }

    await client.query(
      `INSERT INTO ifrs9_posting_ledger(
        organization_id, run_id, period_id, journal_entry_id, idempotency_key, posted_by, posted_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      [orgId, run.id, payload.period_id, posted.journalId, idempotencyKey, actorUserId]
    );

    const { rows: upd } = await client.query(
      `UPDATE ifrs9_ecl_runs
       SET status='posted', journal_entry_id=$3, posted_by=$4, posted_at=NOW(), updated_at=NOW()
       WHERE organization_id=$1 AND id=$2
       RETURNING *`,
      [orgId, run.id, posted.journalId, actorUserId]
    );

    await client.query("COMMIT");
    await safeWriteAudit({
      organizationId: orgId,
      actorUserId,
      action: "ifrs9.run.post",
      entityType: "ifrs9_ecl_run",
      entityId: run.id,
      ip: audit.ip,
      userAgent: audit.userAgent,
      after: { run_id: upd[0].id, journal_id: upd[0].journal_entry_id }
    });
    return { run_id: upd[0].id, journal_id: upd[0].journal_entry_id, already_posted: false };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function reverseEclPosting({ orgId, actorUserId, payload, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: runRows } = await client.query(
      `SELECT * FROM ifrs9_ecl_runs WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.run_id]
    );
    if (!runRows.length) throw new AppError(404, "Run not found");
    const run = runRows[0];
    if (run.status !== "posted") throw new AppError(409, "Run is not posted");
    if (!run.journal_entry_id) throw new AppError(409, "Run has no journal to reverse");

    const targetPeriod = await getPeriodOrThrow(client, orgId, payload.target_period_id);
    if (targetPeriod.status !== "open") throw new AppError(409, "Target period is not open");

    const idempotencyKey = `IFRS9:ECL:RUN:${run.id}:REV:${payload.target_period_id}`;
    const out = await journalPosting.reversePostedJournal({
      orgId,
      journalId: run.journal_entry_id,
      actorUserId,
      targetPeriodId: payload.target_period_id,
      entryDate: payload.entry_date,
      reason: payload.reason,
      idempotencyKey
    });

    await client.query(
      `UPDATE ifrs9_ecl_runs
       SET status='reversed', reversal_journal_entry_id=$3, reversed_by=$4, reversed_at=NOW(), updated_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [orgId, run.id, out.reversalJournalId || null, actorUserId]
    );

    await client.query(
      `UPDATE ifrs9_posting_ledger
       SET reversal_journal_entry_id=$4, reversed_by=$5, reversed_at=NOW()
       WHERE organization_id=$1 AND run_id=$2 AND period_id=$3`,
      [orgId, run.id, run.period_id, out.reversalJournalId || null, actorUserId]
    );

    await client.query("COMMIT");
    await safeWriteAudit({
      organizationId: orgId,
      actorUserId,
      action: "ifrs9.run.reverse",
      entityType: "ifrs9_ecl_run",
      entityId: run.id,
      ip: audit.ip,
      userAgent: audit.userAgent,
      after: { run_id: run.id, reversal_journal_id: out.reversalJournalId }
    });
    return { run_id: run.id, reversal_journal_id: out.reversalJournalId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// --------------------------------------
// Reports
// --------------------------------------

async function getAllowanceMovementReport({ orgId, periodId }) {
  if (!periodId) throw new AppError(400, "period_id is required");
  const client = await pool.connect();
  try {
    const period = await getPeriodOrThrow(client, orgId, periodId);

    const { rows: openingRows } = await client.query(
      `SELECT total_ecl, posted_at, id
       FROM ifrs9_ecl_runs
       WHERE organization_id=$1
         AND status='posted'
         AND posted_at < ($2::date::timestamptz)
       ORDER BY posted_at DESC
       LIMIT 1`,
      [orgId, period.start_date]
    );
    const openingAllowance = openingRows.length ? Number(openingRows[0].total_ecl) : 0;

    const { rows: runRows } = await client.query(
      `SELECT id, as_of_date, approach, status,
              total_exposure, total_ecl, prior_posted_ecl, delta_allowance,
              posted_at, journal_entry_id,
              reversal_journal_entry_id, reversed_at
       FROM ifrs9_ecl_runs
       WHERE organization_id=$1
         AND period_id=$2
         AND status IN ('posted','reversed')
       ORDER BY posted_at ASC NULLS LAST, created_at ASC`,
      [orgId, periodId]
    );

    const effectiveRuns = runRows.filter((r) => r.status === "posted" && !r.reversed_at);
    const additions = effectiveRuns.map((r) => Number(r.delta_allowance)).filter((d) => d > 0).reduce((a, b) => a + b, 0);
    const releases = effectiveRuns.map((r) => Number(r.delta_allowance)).filter((d) => d < 0).reduce((a, b) => a + Math.abs(b), 0);
    const netMovement = additions - releases;
    const closingAllowance = openingAllowance + netMovement;

    return {
      period: {
        id: period.id,
        code: period.code,
        label: period.period_label || getPeriodLabel(period),
        start_date: period.start_date,
        end_date: period.end_date,
        status: period.status
      },
      opening_allowance: openingAllowance,
      additions,
      releases,
      net_movement: netMovement,
      closing_allowance: closingAllowance,
      runs: effectiveRuns.map((r) => ({
        id: r.id,
        as_of_date: r.as_of_date,
        approach: r.approach,
        total_exposure: Number(r.total_exposure),
        total_ecl: Number(r.total_ecl),
        prior_posted_ecl: Number(r.prior_posted_ecl),
        delta_allowance: Number(r.delta_allowance),
        posted_at: r.posted_at,
        journal_entry_id: r.journal_entry_id
      }))
    };
  } finally {
    client.release();
  }
}

async function getDisclosuresReport({ orgId, runId }) {
  if (!runId) throw new AppError(400, "run_id is required");
  const client = await pool.connect();
  try {
    const { rows: runRows } = await client.query(
      `SELECT r.*, p.code AS period_code, p.start_date, p.end_date, m.code AS model_code, m.name AS model_name
       FROM ifrs9_ecl_runs r
       LEFT JOIN accounting_periods p ON p.id = r.period_id
       LEFT JOIN ifrs9_ecl_models m ON m.id = r.model_id
       WHERE r.organization_id=$1 AND r.id=$2`,
      [orgId, runId]
    );
    if (!runRows.length) throw new AppError(404, "Run not found");
    const run = buildRunSummary(runRows[0]);

    const { rows: byStage } = await client.query(
      `SELECT COALESCE(stage, 1) AS stage,
              COUNT(*)::INT AS line_count,
              COALESCE(SUM(invoice_count),0)::INT AS invoice_count,
              COALESCE(SUM(contract_asset_count),0)::INT AS contract_asset_count,
              COALESCE(SUM(exposure_amount),0) AS exposure_amount,
              COALESCE(SUM(ecl_amount),0) AS ecl_amount
       FROM ifrs9_ecl_run_lines
       WHERE run_id=$1
       GROUP BY COALESCE(stage, 1)
       ORDER BY stage`,
      [runId]
    );

    const { rows: byBucket } = await client.query(
      `SELECT bucket_label,
              COALESCE(SUM(invoice_count),0)::INT AS invoice_count,
              COALESCE(SUM(contract_asset_count),0)::INT AS contract_asset_count,
              COALESCE(SUM(exposure_amount),0) AS exposure_amount,
              COALESCE(SUM(ecl_amount),0) AS ecl_amount
       FROM ifrs9_ecl_run_lines
       WHERE run_id=$1
         AND bucket_label IS NOT NULL
       GROUP BY bucket_label
       ORDER BY MIN(days_past_due_from) ASC`,
      [runId]
    );

    const { rows: topCounterparties } = await client.query(
      `SELECT rl.customer_id,
              bp.name AS customer_name,
              COALESCE(SUM(rl.exposure_amount),0) AS exposure_amount,
              COALESCE(SUM(rl.ecl_amount),0) AS ecl_amount,
              COALESCE(SUM(rl.invoice_count),0)::INT AS invoice_count,
              COALESCE(SUM(rl.contract_asset_count),0)::INT AS contract_asset_count
       FROM ifrs9_ecl_run_lines rl
       JOIN business_partners bp ON bp.id = rl.customer_id
       WHERE rl.run_id=$1
       GROUP BY rl.customer_id, bp.name
       ORDER BY exposure_amount DESC
       LIMIT 10`,
      [runId]
    );

    const { rows: bySourceMix } = await client.query(
      `SELECT
          COALESCE(SUM(COALESCE(invoice_count,0)),0)::INT AS invoice_count,
          COALESCE(SUM(COALESCE(contract_asset_count,0)),0)::INT AS contract_asset_count,
          COALESCE(SUM(exposure_amount),0) AS exposure_amount,
          COALESCE(SUM(ecl_amount),0) AS ecl_amount
       FROM ifrs9_ecl_run_lines
       WHERE run_id=$1`,
      [runId]
    );

    return {
      run,
      validation: {
        status: run.validation_status,
        coverage_summary: run.coverage_summary || null
      },
      breakdown: {
        by_stage: byStage.map((r) => ({
          stage: Number(r.stage),
          line_count: Number(r.line_count),
          invoice_count: Number(r.invoice_count),
          contract_asset_count: Number(r.contract_asset_count),
          exposure_amount: Number(r.exposure_amount),
          ecl_amount: Number(r.ecl_amount)
        })),
        by_bucket: byBucket.map((r) => ({
          bucket_label: r.bucket_label,
          invoice_count: Number(r.invoice_count),
          contract_asset_count: Number(r.contract_asset_count),
          exposure_amount: Number(r.exposure_amount),
          ecl_amount: Number(r.ecl_amount)
        })),
        top_counterparties: topCounterparties.map((r) => ({
          customer_id: r.customer_id,
          customer_name: r.customer_name,
          exposure_amount: Number(r.exposure_amount),
          ecl_amount: Number(r.ecl_amount),
          invoice_count: Number(r.invoice_count),
          contract_asset_count: Number(r.contract_asset_count)
        })),
        by_source_mix: bySourceMix.map((r) => ({
          invoice_count: Number(r.invoice_count),
          contract_asset_count: Number(r.contract_asset_count),
          exposure_amount: Number(r.exposure_amount),
          ecl_amount: Number(r.ecl_amount)
        }))[0] || {
          invoice_count: 0,
          contract_asset_count: 0,
          exposure_amount: 0,
          ecl_amount: 0
        }
      }
    };
  } finally {
    client.release();
  }
}


async function listMacroScenarios({ orgId }) {
  const { rows } = await pool.query(
    `SELECT s.*,
            COALESCE(o.overlay_count,0)::INT AS overlay_count
     FROM ifrs9_macro_scenarios s
     LEFT JOIN (
       SELECT scenario_id, COUNT(*) AS overlay_count
       FROM ifrs9_macro_scenario_overlays
       GROUP BY scenario_id
     ) o ON o.scenario_id = s.id
     WHERE s.organization_id=$1
     ORDER BY s.code ASC`,
    [orgId]
  );
  return rows;
}

async function createMacroScenario({ orgId, actorUserId, payload, audit = {} }) {
  const code = slugifyCode(payload.code || payload.name);
  const { rows } = await pool.query(
    `INSERT INTO ifrs9_macro_scenarios(
      organization_id, code, name, description, scenario_type, probability_weight, status,
      variable_set, effective_from, effective_to, created_by, updated_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$11,NOW(),NOW()) RETURNING *`,
    [
      orgId,
      code,
      payload.name,
      payload.description || null,
      payload.scenario_type || 'BASE',
      payload.probability_weight ?? 1,
      payload.status || 'active',
      JSON.stringify(payload.variable_set || {}),
      payload.effective_from || null,
      payload.effective_to || null,
      actorUserId
    ]
  );
  await safeWriteAudit({ organizationId: orgId, actorUserId, action: 'ifrs9.scenario.create', entityType: 'ifrs9_macro_scenario', entityId: rows[0].id, ip: audit.ip, userAgent: audit.userAgent, after: rows[0] });
  return rows[0];
}

async function upsertMacroScenarioOverlay({ orgId, actorUserId, scenarioId, payload, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: srows } = await client.query(`SELECT id FROM ifrs9_macro_scenarios WHERE organization_id=$1 AND id=$2`, [orgId, scenarioId]);
    if (!srows.length) throw new AppError(404, 'Scenario not found');
    if (payload.model_id) await getActiveModelOrThrow(client, orgId, payload.model_id);
    const { rows } = await client.query(
      `INSERT INTO ifrs9_macro_scenario_overlays(
        organization_id, scenario_id, model_id, segment, stage,
        days_past_due_from, days_past_due_to,
        pd_multiplier, lgd_multiplier, loss_rate_multiplier, ecl_multiplier,
        notes, created_by, updated_by, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,NOW(),NOW()) RETURNING *`,
      [
        orgId,
        scenarioId,
        payload.model_id || null,
        payload.segment || null,
        payload.stage ?? null,
        payload.days_past_due_from ?? null,
        payload.days_past_due_to ?? null,
        payload.pd_multiplier ?? 1,
        payload.lgd_multiplier ?? 1,
        payload.loss_rate_multiplier ?? 1,
        payload.ecl_multiplier ?? 1,
        payload.notes || null,
        actorUserId
      ]
    );
    await client.query('COMMIT');
    await safeWriteAudit({ organizationId: orgId, actorUserId, action: 'ifrs9.scenario_overlay.upsert', entityType: 'ifrs9_macro_scenario_overlay', entityId: rows[0].id, ip: audit.ip, userAgent: audit.userAgent, after: rows[0] });
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function listSicrTriggers({ orgId }) {
  const { rows } = await pool.query(`SELECT * FROM ifrs9_sicr_qualitative_triggers WHERE organization_id=$1 ORDER BY created_at DESC`, [orgId]);
  return rows;
}

async function upsertSicrTrigger({ orgId, actorUserId, payload, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (payload.business_partner_id) {
      const { rows: bp } = await client.query(`SELECT id FROM business_partners WHERE organization_id=$1 AND id=$2`, [orgId, payload.business_partner_id]);
      if (!bp.length) throw new AppError(400, 'Invalid business_partner_id');
    }
    const { rows } = await client.query(
      `INSERT INTO ifrs9_sicr_qualitative_triggers(
        organization_id, business_partner_id, segment, trigger_code, trigger_name, severity,
        force_stage_min, pd_multiplier, lgd_multiplier, status,
        valid_from, valid_to, source, notes, metadata,
        created_by, updated_by, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$16,NOW(),NOW()) RETURNING *`,
      [orgId, payload.business_partner_id || null, payload.segment || null, payload.trigger_code, payload.trigger_name, payload.severity || 'medium', payload.force_stage_min ?? null, payload.pd_multiplier ?? 1, payload.lgd_multiplier ?? 1, payload.status || 'active', payload.valid_from || null, payload.valid_to || null, payload.source || null, payload.notes || null, JSON.stringify(payload.metadata || {}), actorUserId]
    );
    await client.query('COMMIT');
    await safeWriteAudit({ organizationId: orgId, actorUserId, action: 'ifrs9.sicr_trigger.upsert', entityType: 'ifrs9_sicr_trigger', entityId: rows[0].id, ip: audit.ip, userAgent: audit.userAgent, after: rows[0] });
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function getBehavioralAnalytics({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await computeBehavioralAnalyticsEngine(client, orgId, actorUserId, {
      asOfDate: payload.as_of_date,
      horizonMonths: payload.horizon_months || 12,
      transitionWindowDays: payload.transition_window_days || 30,
      persistSnapshot: !!payload.persist_snapshot
    });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function listModelChangeRequests({ orgId, status = null }) {
  const params = [orgId];
  let where = 'r.organization_id=$1';
  if (status) {
    params.push(status);
    where += ` AND r.status=$${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT r.*, m.code AS model_code, m.name AS model_name
     FROM ifrs9_model_change_requests r
     LEFT JOIN ifrs9_ecl_models m ON m.id = r.model_id
     WHERE ${where}
     ORDER BY r.created_at DESC`,
    params
  );
  return rows;
}

async function createModelChangeRequest({ orgId, actorUserId, payload, audit = {} }) {
  const { rows } = await pool.query(
    `INSERT INTO ifrs9_model_change_requests(
      organization_id, model_id, change_type, title, reason, payload, status,
      created_by, updated_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'draft',$7,$7,NOW(),NOW()) RETURNING *`,
    [orgId, payload.model_id || null, payload.change_type, payload.title, payload.reason || null, JSON.stringify(payload.payload || {}), actorUserId]
  );
  await safeWriteAudit({ organizationId: orgId, actorUserId, action: 'ifrs9.model_change.create', entityType: 'ifrs9_model_change', entityId: rows[0].id, ip: audit.ip, userAgent: audit.userAgent, after: rows[0] });
  return rows[0];
}

async function getModelChangeOrThrow(client, orgId, changeId) {
  const { rows } = await client.query(`SELECT * FROM ifrs9_model_change_requests WHERE organization_id=$1 AND id=$2`, [orgId, changeId]);
  if (!rows.length) throw new AppError(404, 'Model change request not found');
  return rows[0];
}

async function submitModelChangeRequest({ orgId, actorUserId, changeId, comment, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const change = await getModelChangeOrThrow(client, orgId, changeId);
    if (!['draft', 'rejected'].includes(change.status)) throw new AppError(409, 'Only draft or rejected requests can be submitted');
    const submittedDoc = await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: 'ifrs9_model_change',
      entity: { id: change.id, code: change.change_type, title: change.title, memo: comment || change.reason },
      workflowDocumentId: change.workflow_document_id,
      snapshot: { title: change.title, reason: change.reason, change_type: change.change_type, payload: change.payload },
      client,
      persistWorkflowDocumentId: async (docId) => {
        await client.query(`UPDATE ifrs9_model_change_requests SET workflow_document_id=$3 WHERE organization_id=$1 AND id=$2`, [orgId, change.id, docId]);
      }
    });
    const { rows } = await client.query(
      `UPDATE ifrs9_model_change_requests
       SET status='submitted', submitted_at=NOW(), submitted_by=$3, updated_by=$3, updated_at=NOW(), workflow_document_id=COALESCE(workflow_document_id,$4)
       WHERE organization_id=$1 AND id=$2
       RETURNING *`,
      [orgId, change.id, actorUserId, submittedDoc.id]
    );
    await client.query('COMMIT');
    await safeWriteAudit({ organizationId: orgId, actorUserId, action: 'ifrs9.model_change.submit', entityType: 'ifrs9_model_change', entityId: change.id, ip: audit.ip, userAgent: audit.userAgent, after: rows[0] });
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function approveModelChangeRequest({ orgId, actorUserId, changeId, comment, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const change = await getModelChangeOrThrow(client, orgId, changeId);
    if (change.status !== 'submitted') throw new AppError(409, 'Only submitted requests can be approved');
    if (!change.workflow_document_id) throw new AppError(409, 'Model change request has no workflow document');
    await documentableSvc.approveEntityDocument({ orgId, actorUserId, entityType: 'ifrs9_model_change', workflowDocumentId: change.workflow_document_id, creatorUserId: change.created_by, comment, client });
    const { rows } = await client.query(
      `UPDATE ifrs9_model_change_requests
       SET status='approved', approved_at=NOW(), approved_by=$3, updated_by=$3, updated_at=NOW()
       WHERE organization_id=$1 AND id=$2
       RETURNING *`,
      [orgId, change.id, actorUserId]
    );
    await client.query('COMMIT');
    await safeWriteAudit({ organizationId: orgId, actorUserId, action: 'ifrs9.model_change.approve', entityType: 'ifrs9_model_change', entityId: change.id, ip: audit.ip, userAgent: audit.userAgent, after: rows[0] });
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function rejectModelChangeRequest({ orgId, actorUserId, changeId, comment, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const change = await getModelChangeOrThrow(client, orgId, changeId);
    if (change.status !== 'submitted') throw new AppError(409, 'Only submitted requests can be rejected');
    if (!change.workflow_document_id) throw new AppError(409, 'Model change request has no workflow document');
    await documentableSvc.rejectEntityDocument({ orgId, actorUserId, entityType: 'ifrs9_model_change', workflowDocumentId: change.workflow_document_id, creatorUserId: change.created_by, comment, client });
    const { rows } = await client.query(
      `UPDATE ifrs9_model_change_requests
       SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_comment=$4, updated_by=$3, updated_at=NOW()
       WHERE organization_id=$1 AND id=$2
       RETURNING *`,
      [orgId, change.id, actorUserId, comment || null]
    );
    await client.query('COMMIT');
    await safeWriteAudit({ organizationId: orgId, actorUserId, action: 'ifrs9.model_change.reject', entityType: 'ifrs9_model_change', entityId: change.id, ip: audit.ip, userAgent: audit.userAgent, after: rows[0] });
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function applyModelChangeRequest({ orgId, actorUserId, changeId, audit = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const change = await getModelChangeOrThrow(client, orgId, changeId);
    if (change.status !== 'approved') throw new AppError(409, 'Only approved requests can be applied');
    const payload = change.payload || {};
    let result = null;
    await client.query('COMMIT');

    if (change.change_type === 'SETTINGS_UPSERT') {
      result = await upsertIfrs9Settings({ orgId, actorUserId, payload, audit });
    } else if (change.change_type === 'MODEL_CREATE') {
      result = await createEclModel({ orgId, actorUserId, payload, audit });
    } else if (change.change_type === 'BUCKET_ADD') {
      result = await addEclBucket({ orgId, actorUserId, modelId: change.model_id || payload.model_id, payload, audit });
    } else if (change.change_type === 'PARAMETER_ADD') {
      result = await addEclParameter({ orgId, actorUserId, modelId: change.model_id || payload.model_id, payload, audit });
    } else if (change.change_type === 'SCENARIO_CREATE') {
      result = await createMacroScenario({ orgId, actorUserId, payload, audit });
    } else if (change.change_type === 'SCENARIO_OVERLAY_UPSERT') {
      result = await upsertMacroScenarioOverlay({ orgId, actorUserId, scenarioId: payload.scenario_id, payload, audit });
    } else if (change.change_type === 'SICR_TRIGGER_UPSERT') {
      result = await upsertSicrTrigger({ orgId, actorUserId, payload, audit });
    } else {
      throw new AppError(400, `Unsupported change_type: ${change.change_type}`);
    }

    const { rows } = await pool.query(
      `UPDATE ifrs9_model_change_requests
       SET status='applied', applied_at=NOW(), applied_by=$3, updated_by=$3, updated_at=NOW()
       WHERE organization_id=$1 AND id=$2
       RETURNING *`,
      [orgId, change.id, actorUserId]
    );
    await safeWriteAudit({ organizationId: orgId, actorUserId, action: 'ifrs9.model_change.apply', entityType: 'ifrs9_model_change', entityId: change.id, ip: audit.ip, userAgent: audit.userAgent, after: { request: rows[0], result } });
    return { request: rows[0], result };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally { client.release(); }
}

module.exports = {
  getIfrs9Settings,
  upsertIfrs9Settings,
  listEclModels,
  createEclModel,
  addEclParameter,
  getCounterpartyProfile,
  upsertCounterpartyProfile,
  addEclBucket,
  computeEcl,
  getRunDetails,
  listRuns,
  finalizeRun,
  postEcl,
  reverseEclPosting,
  getAllowanceMovementReport,
  getDisclosuresReport,
  listMacroScenarios,
  createMacroScenario,
  upsertMacroScenarioOverlay,
  listSicrTriggers,
  upsertSicrTrigger,
  getBehavioralAnalytics,
  listModelChangeRequests,
  createModelChangeRequest,
  submitModelChangeRequest,
  approveModelChangeRequest,
  rejectModelChangeRequest,
  applyModelChangeRequest
};
