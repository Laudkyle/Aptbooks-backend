
const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const Decimal = require("decimal.js");
const crypto = require("crypto");
const logger = require("../../config/logger");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const journalPosting = require("../../interfaces/journalPosting.interface");

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
  return normalized;
}

function serializeSettings(row) {
  if (!row) return null;
  return {
    ...row,
    allowance_account_id: row.loss_allowance_account_id || null,
    stage2_days_past_due: row.stage2_threshold_days,
    stage3_days_past_due: row.stage3_threshold_days
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
    `SELECT id, code, name, status, start_date, end_date
     FROM accounting_periods
     WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(400, "Invalid period_id");
  return rows[0];
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
    period_name: run.period_name,
    model_code: run.model_code,
    model_name: run.model_name,
    as_of_date: run.as_of_date,
    approach: run.approach,
    status: run.status,
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
    reversed_at: run.reversed_at
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
        updated_by,
        updated_at,
        created_at
      )
      VALUES ($1,$2,$3,$4,COALESCE($5,2),COALESCE($6,30),COALESCE($7,90),COALESCE($8,0.45),COALESCE($9,0.10),$10,NOW(),NOW())
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
    `SELECT m.id, m.code, m.name, m.description, m.model_type, m.status, m.created_at, m.updated_at,
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
      organization_id, code, name, description, model_type, status, created_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW()) RETURNING *`,
    [orgId, code, payload.name, payload.description || null, normalizedType, payload.status || "active", actorUserId]
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
      if (model.model_type !== "GENERAL") {
        throw new AppError(409, "Selected model is not GENERAL");
      }
      params = await listModelParameters(client, orgId, modelId);
      if (!params.length) throw new AppError(409, "GENERAL model has no parameters");
    }

    const asOfDate = parseAsOfDate(period, payload.as_of_date);

    const { rows: invRows } = await client.query(
      `SELECT
        i.id,
        i.customer_id,
        i.invoice_no AS doc_no,
        i.invoice_date AS doc_date,
        i.due_date,
        GREATEST(
          0,
          COALESCE(i.total, 0) - COALESCE(SUM(a.amount_applied) FILTER (WHERE r.status = 'posted'), 0)
        ) AS amount,
        'INVOICE'::text AS source_type
      FROM invoices i
      LEFT JOIN customer_receipt_allocations a ON a.invoice_id = i.id
      LEFT JOIN customer_receipts r
        ON r.id = a.customer_receipt_id
       AND r.organization_id = i.organization_id
       AND r.receipt_date <= $2::date
      WHERE i.organization_id=$1
        AND i.status='issued'
        AND i.invoice_date <= $2::date
      GROUP BY i.id, i.customer_id, i.invoice_no, i.invoice_date, i.due_date, i.total
      HAVING GREATEST(
          0,
          COALESCE(i.total, 0) - COALESCE(SUM(a.amount_applied) FILTER (WHERE r.status = 'posted'), 0)
        ) > 0`,
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
    const stageCache = new Map();

    for (const ex of exposureRows) {
      if (!ex.customer_id) continue;
      const daysPastDue = Math.max(0, daysBetween(ex.due_date, asOfDate));

      if (approach === "SIMPLIFIED") {
        const bucket = pickBucket(buckets, daysPastDue);
        if (!bucket) continue;
        const key = `${ex.customer_id}:${bucket.id}:S`;
        if (!lines.has(key)) {
          lines.set(key, {
            customer_id: ex.customer_id,
            bucket_id: bucket.id,
            bucket_label: bucket.label,
            days_past_due_from: bucket.days_past_due_from,
            days_past_due_to: bucket.days_past_due_to,
            loss_rate: bucket.loss_rate,
            stage: 1,
            pd_used: null,
            lgd_used: null,
            param_id: null,
            invoice_count: 0,
            contract_asset_count: 0,
            exposure: new Decimal(0)
          });
        }
        const agg = lines.get(key);
        if (ex.source_type === "INVOICE") agg.invoice_count += 1;
        if (ex.source_type === "CONTRACT_ASSET") agg.contract_asset_count += 1;
        agg.exposure = agg.exposure.plus(new Decimal(ex.amount || 0));
      } else {
        let stage = stageCache.get(ex.customer_id);
        if (!stage) {
          stage = await getCounterpartyStage(client, orgId, ex.customer_id, daysPastDue, settings);
          stageCache.set(ex.customer_id, stage);
        }
        const p = pickParameter(params, stage, daysPastDue);
        if (!p) continue;
        const key = `${ex.customer_id}:${p.id}:${stage}`;
        if (!lines.has(key)) {
          lines.set(key, {
            customer_id: ex.customer_id,
            bucket_id: null,
            bucket_label: p.label,
            days_past_due_from: p.days_past_due_from,
            days_past_due_to: p.days_past_due_to,
            loss_rate: null,
            stage,
            pd_used: null,
            lgd_used: null,
            param_id: p.id,
            invoice_count: 0,
            contract_asset_count: 0,
            exposure: new Decimal(0)
          });
        }
        const agg = lines.get(key);
        if (ex.source_type === "INVOICE") agg.invoice_count += 1;
        if (ex.source_type === "CONTRACT_ASSET") agg.contract_asset_count += 1;
        agg.exposure = agg.exposure.plus(new Decimal(ex.amount || 0));
      }
    }

    const runId = crypto.randomUUID();
    let totalExposure = new Decimal(0);
    let totalEcl = new Decimal(0);
    const priorEcl = await sumPriorPostedEcl(client, orgId, period.end_date);

    const computedLines = Array.from(lines.values()).map((l) => {
      const exposure = roundMoney(l.exposure, rounding);
      let ecl;
      let pdUsed = null;
      let lgdUsed = null;
      let ead = null;

      if (approach === "SIMPLIFIED") {
        ecl = roundMoney(exposure.mul(new Decimal(l.loss_rate)), rounding);
      } else {
        const p = params.find((x) => x.id === l.param_id);
        const stage = Number(l.stage);
        const pd = stage === 1 ? new Decimal(p.pd_12m) : new Decimal(p.pd_lifetime);
        const lgd = p.lgd === null || p.lgd === undefined ? new Decimal(settings.default_lgd ?? 0.45) : new Decimal(p.lgd);
        const eclRaw = exposure.mul(pd).mul(lgd);
        ecl = roundMoney(eclRaw, rounding);
        pdUsed = pd.toNumber();
        lgdUsed = lgd.toNumber();
        ead = exposure.toNumber();
      }
      totalExposure = totalExposure.plus(exposure);
      totalEcl = totalEcl.plus(ecl);
      return {
        ...l,
        exposure_amount: exposure,
        ecl_amount: ecl,
        pd_used: pdUsed,
        lgd_used: lgdUsed,
        ead_amount: ead
      };
    });

    totalExposure = roundMoney(totalExposure, rounding);
    totalEcl = roundMoney(totalEcl, rounding);
    const deltaAllowance = roundMoney(totalEcl.minus(priorEcl), rounding);

    await client.query(
      `INSERT INTO ifrs9_ecl_runs(
        id, organization_id, period_id, model_id, as_of_date, status,
        approach,
        total_exposure, total_ecl, prior_posted_ecl, delta_allowance,
        memo, created_by, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,'computed',$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())`,
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
        actorUserId
      ]
    );

    for (const l of computedLines) {
      await client.query(
        `INSERT INTO ifrs9_ecl_run_lines(
          run_id, customer_id, bucket_id, bucket_label,
          days_past_due_from, days_past_due_to, loss_rate,
          invoice_count, contract_asset_count, exposure_amount, ecl_amount,
          stage, pd_used, lgd_used, ead_amount
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
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
          l.ead_amount
        ]
      );
    }

    await client.query("COMMIT");
    const out = await getRunDetails({ orgId, runId });
    await safeWriteAudit({
      organizationId: orgId,
      actorUserId,
      action: "ifrs9.run.compute",
      entityType: "ifrs9_ecl_run",
      entityId: runId,
      ip: audit.ip,
      userAgent: audit.userAgent,
      after: out.run
    });
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getRunDetails({ orgId, runId }) {
  const { rows } = await pool.query(
    `SELECT r.*, p.code AS period_code, p.name AS period_name, m.code AS model_code, m.name AS model_name
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
      delta_allowance: run.delta_allowance
    },
    lines: lines.map((l) => ({
      ...l,
      exposure_amount: Number(l.exposure_amount || 0),
      ecl_amount: Number(l.ecl_amount || 0),
      loss_rate: l.loss_rate === null || l.loss_rate === undefined ? null : Number(l.loss_rate),
      pd_used: l.pd_used === null || l.pd_used === undefined ? null : Number(l.pd_used),
      lgd_used: l.lgd_used === null || l.lgd_used === undefined ? null : Number(l.lgd_used),
      ead_amount: l.ead_amount === null || l.ead_amount === undefined ? null : Number(l.ead_amount)
    }))
  };
}

async function listRuns({ orgId, periodId }) {
  const params = [orgId];
  let where = `r.organization_id=$1`;
  if (periodId) {
    params.push(periodId);
    where += ` AND r.period_id=$${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT r.*, p.code AS period_code, p.name AS period_name, m.code AS model_code, m.name AS model_name
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

    const posted = await journalPosting.postJournal({ orgId, actorUserId, payload: journalPayload });

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
        name: period.name,
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
      `SELECT r.*, p.code AS period_code, p.name AS period_name, m.code AS model_code, m.name AS model_name
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

    return {
      run,
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
        }))
      }
    };
  } finally {
    client.release();
  }
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
  getDisclosuresReport
};
