const { AppError } = require("../../shared/errors/AppError");
const repo = require("./forecasts.repository");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");

function assertName(name) {
  if (!name || typeof name !== "string") throw new AppError(400, "name is required");
}

async function listForecasts({ orgId }) {
  return repo.listForecasts({ orgId });
}

async function createForecast({ orgId, name, currencyCode, status, actorUserId, req }) {
  assertName(name);
  if (!currencyCode) throw new AppError(400, "currencyCode is required");
  const created = await repo.createForecast({ orgId, name, currencyCode, status, createdByUserId: actorUserId });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.forecast.create",
    entityType: "forecast",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });
  return created;
}

async function upsertLines({ orgId, forecastId, lines, actorUserId, req }) {
  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");
  if (!Array.isArray(lines)) throw new AppError(400, "lines must be an array");

  const saved = [];
  for (const line of lines) {
    if (!line.accountId) throw new AppError(400, "Each line requires accountId");
    if (!line.periodId) throw new AppError(400, "Each line requires periodId");
    if (line.amount === undefined || line.amount === null) throw new AppError(400, "Each line requires amount");
    const row = await repo.upsertLine({
      orgId,
      forecastId,
      accountId: line.accountId,
      periodId: line.periodId,
      amount: Number(line.amount),
      dimensionJson: line.dimensionJson || {},
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
    after: { forecastId, count: saved.length },
  });

  return saved;
}

async function getVariance({ orgId, forecastId, periodId }) {
  if (!periodId) throw new AppError(400, "periodId is required");
  const f = await repo.getForecast({ orgId, id: forecastId });
  if (!f) throw new AppError(404, "Forecast not found");

  const rows = await repo.getVariance({ orgId, forecastId, periodId });
  const totals = rows.reduce(
    (acc, r) => {
      acc.forecast += Number(r.forecast_amount || 0);
      acc.actual += Number(r.actual_net || 0);
      acc.variance += Number(r.variance || 0);
      return acc;
    },
    { forecast: 0, actual: 0, variance: 0 }
  );
  return { periodId, forecastId, totals, lines: rows };
}

module.exports = { listForecasts, createForecast, upsertLines, getVariance };
