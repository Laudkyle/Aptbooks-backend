const { AppError } = require("../../shared/errors/AppError");
const repo = require("./forecasts.repository");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const { assertMoneyAmount, assertUuid, normalizeStatus } = require("../_util");
const { validateDimensionJson } = require("../dimensions/dimensions.validator");

const FORECAST_STATUS = ["draft", "active", "archived"];
// Forecast versions are "scenarios". We keep lifecycle simple and enforce edit locks.
const VERSION_STATUS = ["draft", "active", "archived"];

function assertName(name, field = "name") {
  if (!name || typeof name !== "string" || !name.trim()) throw new AppError(400, `${field} is required`);
}

async function listForecasts({ orgId, status, limit = 100, offset = 0 }) {
  const st = status ? normalizeStatus(status, FORECAST_STATUS) : null;
  return repo.listForecasts({ orgId, status: st, limit, offset });
}

async function createForecast({ orgId, name, currencyCode, status = "draft", actorUserId, req }) {
  assertName(name);
  if (!currencyCode || typeof currencyCode !== "string") throw new AppError(400, "currencyCode is required");
  const st = normalizeStatus(status, FORECAST_STATUS);

  const created = await repo.createForecastWithDefaultVersion({
    orgId,
    name: name.trim(),
    currencyCode: currencyCode.trim().toUpperCase(),
    status: st,
    createdByUserId: actorUserId,
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.create",
    entityType: "forecast",
    entityId: created.forecast.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });

  // Return a flattened envelope for API consumers.
  return {
    ...created.forecast,
    default_version: created.version,
  };
}

async function createVersion({ orgId, forecastId, versionNo, name, status = "draft", actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  if (!Number.isInteger(versionNo) || versionNo <= 0) throw new AppError(400, "versionNo must be a positive integer");
  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (f.status === "archived") throw new AppError(409, "Forecast is archived");

  const created = await repo.createVersion({
    orgId,
    forecastId,
    versionNo,
    name: (name || `Version ${versionNo}`).trim(),
    status: normalizeStatus(status, VERSION_STATUS, "status"),
    createdByUserId: actorUserId,
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.version.create",
    entityType: "forecast_version",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });

  return created;
}

async function upsertLines({ orgId, forecastId, versionId = null, lines, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  if (!Array.isArray(lines)) throw new AppError(400, "lines must be an array");

  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (f.status === "archived") throw new AppError(409, "Forecast is archived");

  // Backwards compatible behaviour:
  // - If versionId not supplied, write into the latest DRAFT version.
  const v = versionId
    ? await repo.getVersionById({ orgId, id: versionId, forecastId })
    : await repo.getLatestDraftVersion({ orgId, forecastId });

  if (!v) throw new AppError(404, "Forecast version not found");
  if (v.status !== "draft") throw new AppError(409, "Only draft forecast versions can be edited");

  const saved = [];
  for (const line of lines) {
    assertUuid(line.accountId, "accountId");
    assertUuid(line.periodId, "periodId");

    const accOk = await repo.assertAccountWritable({ orgId, accountId: line.accountId });
    if (!accOk.ok) {
      throw new AppError(400, `Invalid accountId: ${accOk.reason}`);
    }
    const perOk = await repo.assertPeriodExists({ orgId, periodId: line.periodId });
    if (!perOk.ok) {
      throw new AppError(400, `Invalid periodId: ${perOk.reason}`);
    }

    const amount = assertMoneyAmount(line.amount, "amount");
    const dim = await validateDimensionJson({ orgId, dimensionJson: line.dimensionJson || {} });
    const row = await repo.upsertLine({
      orgId,
      forecastId,
      forecastVersionId: v.id,
      accountId: line.accountId,
      periodId: line.periodId,
      amount,
      dimensionJson: dim,
    });
    saved.push(row);
  }

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.lines.upsert",
    entityType: "forecast_lines",
    entityId: null,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { forecastId, forecastVersionId: v.id, count: saved.length },
  });

  return { forecastId, forecastVersionId: v.id, lines: saved };
}

async function getVariance({ orgId, forecastId, periodId, versionId = null }) {
  assertUuid(forecastId, "forecastId");
  assertUuid(periodId, "periodId");

  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");

  const v = versionId
    ? await repo.getVersionById({ orgId, id: versionId, forecastId })
    : await repo.getLatestActiveOrDraftVersion({ orgId, forecastId });

  if (!v) throw new AppError(404, "Forecast version not found");

  const rows = await repo.getVariance({ orgId, forecastId, forecastVersionId: v.id, periodId });
  const totals = rows.reduce(
    (acc, r) => {
      acc.forecast += Number(r.forecast_amount || 0);
      acc.actual += Number(r.actual_normal || 0);
      acc.variance += Number(r.variance || 0);
      return acc;
    },
    { forecast: 0, actual: 0, variance: 0 }
  );
  return { periodId, forecastId, forecastVersionId: v.id, totals, lines: rows };
}

async function activateForecast({ orgId, forecastId, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (f.status === "archived") throw new AppError(409, "Forecast is archived");

  const activatedVersion = await repo.activateForecast({ orgId, forecastId });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.activate",
    entityType: "forecast",
    entityId: forecastId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: { status: f.status },
    after: { status: "active", activatedVersionId: activatedVersion?.id || null },
  });

  return { forecastId, activatedVersion };
}

async function archiveForecast({ orgId, forecastId, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (f.status === "archived") return { forecastId, status: "archived" };

  await repo.archiveForecast({ orgId, forecastId });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.archive",
    entityType: "forecast",
    entityId: forecastId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: { status: f.status },
    after: { status: "archived" },
  });

  return { forecastId, status: "archived" };
}

async function finalizeVersion({ orgId, forecastId, versionId, actorUserId, req }) {
  assertUuid(forecastId, "forecastId");
  assertUuid(versionId, "versionId");
  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (f.status === "archived") throw new AppError(409, "Forecast is archived");

  const v = await repo.getVersionById({ orgId, id: versionId, forecastId });
  if (!v) throw new AppError(404, "Forecast version not found");
  if (v.status !== "draft") throw new AppError(409, "Only draft versions can be finalised");

  const updated = await repo.finalizeVersion({ orgId, forecastId, versionId });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.version.finalise",
    entityType: "forecast_version",
    entityId: versionId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: { status: v.status },
    after: { status: updated?.status || "active" },
  });
  return updated;
}

module.exports = {
  listForecasts,
  createForecast,
  createVersion,
  upsertLines,
  getVariance,
  activateForecast,
  archiveForecast,
  finalizeVersion,
};
