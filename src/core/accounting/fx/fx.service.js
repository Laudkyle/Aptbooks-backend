const { pool } = require("../../../db/pool");
const { enqueueEvent } = require("../../../modules/webhooks/webhooks.service");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");

function norm(v) {
  return String(v ?? "").trim().toUpperCase();
}

function assertCurrency(code) {
  const c = norm(code);
  if (c.length !== 3) throw new AppError(400, "currencyCode must be 3 letters");
  return c;
}

async function getRateTypeId({ code }) {
  const c = norm(code || "SPOT");
  const { rows } = await pool.query("SELECT id FROM exchange_rate_types WHERE code=$1", [c]);
  if (rows.length) return rows[0].id;
  throw new AppError(400, `Unknown FX rate type: ${c}`);
}

async function createRateType({ code, name, actorUserId, req }) {
  const c = norm(code);
  if (!c) throw new AppError(400, "code is required");
  if (!name) throw new AppError(400, "name is required");
  const { rows } = await pool.query(
    "INSERT INTO exchange_rate_types (code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING *",
    [c, name]
  );
  await writeAudit({
    req,
    organizationId: req?.user?.organization_id,
    actorUserId,
    action: "fx.rate_type.upsert",
    entityType: "exchange_rate_type",
    entityId: rows[0].id,
    after: rows[0],
  });
  return rows[0];
}

async function listRateTypes() {
  const { rows } = await pool.query("SELECT id, code, name FROM exchange_rate_types ORDER BY code");
  return rows;
}

async function upsertRate({ orgId, rateTypeCode = "SPOT", fromCurrency, toCurrency, rate, effectiveDate, actorUserId, req }) {
  const from = assertCurrency(fromCurrency);
  const to = assertCurrency(toCurrency);
  if (from === to) throw new AppError(400, "fromCurrency and toCurrency cannot be the same");
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) throw new AppError(400, "rate must be a positive number");
  if (!effectiveDate) throw new AppError(400, "effectiveDate is required");

  const rateTypeId = await getRateTypeId({ code: rateTypeCode });

  const existing = await pool.query(
    "SELECT id, rate FROM exchange_rates WHERE organization_id=$1 AND rate_type_id=$2 AND from_currency=$3 AND to_currency=$4 AND effective_date=$5",
    [orgId, rateTypeId, from, to, effectiveDate]
  );

  let row;
  if (existing.rows.length) {
    const oldRate = Number(existing.rows[0].rate);
    const upd = await pool.query(
      "UPDATE exchange_rates SET rate=$1 WHERE id=$2 RETURNING *",
      [r, existing.rows[0].id]
    );
    row = upd.rows[0];
    await pool.query(
      "INSERT INTO exchange_rate_history (exchange_rate_id, old_rate, new_rate, changed_by) VALUES ($1,$2,$3,$4)",
      [row.id, oldRate, r, actorUserId]
    );
  } else {
    const ins = await pool.query(
      "INSERT INTO exchange_rates (organization_id, rate_type_id, from_currency, to_currency, rate, effective_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [orgId, rateTypeId, from, to, r, effectiveDate]
    );
    row = ins.rows[0];
    await pool.query(
      "INSERT INTO exchange_rate_history (exchange_rate_id, old_rate, new_rate, changed_by) VALUES ($1,$2,$3,$4)",
      [row.id, r, r, actorUserId]
    );
  }

  await writeAudit({
    req,
    organizationId: orgId,
    actorUserId,
    action: "fx.rate.upsert",
    entityType: "exchange_rate",
    entityId: row.id,
    after: row,
  });

  return row;
}

async function listRates({ orgId, rateTypeCode, fromCurrency, toCurrency, fromDate, toDate, limit = 500 }) {
  const params = [orgId];
  let sql =
    "SELECT er.id, ert.code AS rate_type, er.from_currency, er.to_currency, er.rate, er.effective_date FROM exchange_rates er JOIN exchange_rate_types ert ON ert.id=er.rate_type_id WHERE er.organization_id=$1";

  if (rateTypeCode) {
    params.push(norm(rateTypeCode));
    sql += ` AND ert.code=$${params.length}`;
  }
  if (fromCurrency) {
    params.push(assertCurrency(fromCurrency));
    sql += ` AND er.from_currency=$${params.length}`;
  }
  if (toCurrency) {
    params.push(assertCurrency(toCurrency));
    sql += ` AND er.to_currency=$${params.length}`;
  }
  if (fromDate) {
    params.push(fromDate);
    sql += ` AND er.effective_date >= $${params.length}`;
  }
  if (toDate) {
    params.push(toDate);
    sql += ` AND er.effective_date <= $${params.length}`;
  }
  params.push(Math.min(Number(limit) || 500, 1000));
  sql += ` ORDER BY er.effective_date DESC LIMIT $${params.length}`;

  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getEffectiveRate({ orgId, rateTypeCode = "SPOT", fromCurrency, toCurrency, asOfDate }) {
  const from = assertCurrency(fromCurrency);
  const to = assertCurrency(toCurrency);
  if (from === to) return { rate: 1, inverted: false };
  if (!asOfDate) throw new AppError(400, "asOfDate is required");
  const rateTypeId = await getRateTypeId({ code: rateTypeCode });

  const direct = await pool.query(
    "SELECT rate, effective_date FROM exchange_rates WHERE organization_id=$1 AND rate_type_id=$2 AND from_currency=$3 AND to_currency=$4 AND effective_date <= $5 ORDER BY effective_date DESC LIMIT 1",
    [orgId, rateTypeId, from, to, asOfDate]
  );
  if (direct.rows.length) {
    return { rate: Number(direct.rows[0].rate), inverted: false, effectiveDate: direct.rows[0].effective_date };
  }

  const inv = await pool.query(
    "SELECT rate, effective_date FROM exchange_rates WHERE organization_id=$1 AND rate_type_id=$2 AND from_currency=$3 AND to_currency=$4 AND effective_date <= $5 ORDER BY effective_date DESC LIMIT 1",
    [orgId, rateTypeId, to, from, asOfDate]
  );
  if (inv.rows.length) {
    const base = Number(inv.rows[0].rate);
    if (base <= 0) throw new AppError(400, "Invalid stored FX rate");
    return { rate: 1 / base, inverted: true, effectiveDate: inv.rows[0].effective_date };
  }

  throw new AppError(404, `No FX rate found for ${from}/${to} (${rateTypeCode}) as of ${asOfDate}`);
}

module.exports = {
  createRateType,
  listRateTypes,
  upsertRate,
  listRates,
  getEffectiveRate,
};
