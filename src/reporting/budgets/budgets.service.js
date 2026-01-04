const { AppError } = require("../../shared/errors/AppError");
const repo = require("./budgets.repository");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");

function assertName(name) {
  if (!name || typeof name !== "string") throw new AppError(400, "name is required");
}

async function listBudgets({ orgId }) {
  return repo.listBudgets({ orgId });
}

async function createBudget({ orgId, name, fiscalYear, currencyCode, status, actorUserId, req }) {
  assertName(name);
  if (!currencyCode) throw new AppError(400, "currencyCode is required");
  const created = await repo.createBudget({ orgId, name, fiscalYear, currencyCode, status });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.create",
    entityType: "budget",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });

  return created;
}

async function getBudget({ orgId, id }) {
  const budget = await repo.getBudget({ orgId, id });
  if (!budget) throw new AppError(404, "Budget not found");
  return budget;
}

async function updateBudget({ orgId, id, name, fiscalYear, currencyCode, status, actorUserId, req }) {
  const before = await repo.getBudget({ orgId, id });
  if (!before) throw new AppError(404, "Budget not found");

  const updated = await repo.updateBudget({ orgId, id, name, fiscalYear, currencyCode, status });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.update",
    entityType: "budget",
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before,
    after: updated,
  });

  return updated;
}

async function createVersion({ orgId, budgetId, versionNo, name, status, actorUserId, req }) {
  await getBudget({ orgId, id: budgetId });
  if (typeof versionNo !== "number") throw new AppError(400, "versionNo must be a number");
  const created = await repo.createVersion({ orgId, budgetId, versionNo, name, status, createdByUserId: actorUserId });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.version.create",
    entityType: "budget_version",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });

  return created;
}

async function upsertLines({ orgId, budgetId, versionId, lines, actorUserId, req }) {
  const v = await repo.getVersion({ orgId, budgetId, versionId });
  if (!v) throw new AppError(404, "Budget version not found");
  if (!Array.isArray(lines)) throw new AppError(400, "lines must be an array");

  const saved = [];
  for (const line of lines) {
    if (!line.accountId) throw new AppError(400, "Each line requires accountId");
    if (!line.periodId) throw new AppError(400, "Each line requires periodId");
    if (line.amount === undefined || line.amount === null) throw new AppError(400, "Each line requires amount");
    const row = await repo.upsertLine({
      orgId,
      versionId,
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
    action: "reporting.budget.lines.upsert",
    entityType: "budget_lines",
    entityId: null,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { budgetId, versionId, count: saved.length },
  });

  return saved;
}

async function getVariance({ orgId, budgetId, versionId, periodId }) {
  if (!periodId) throw new AppError(400, "periodId is required");
  const v = await repo.getVersion({ orgId, budgetId, versionId });
  if (!v) throw new AppError(404, "Budget version not found");

  const rows = await repo.getVariance({ orgId, budgetVersionId: versionId, periodId });
  // Provide simple totals for convenience
  const totals = rows.reduce(
    (acc, r) => {
      acc.budget += Number(r.budget_amount || 0);
      acc.actual += Number(r.actual_net || 0);
      acc.variance += Number(r.variance || 0);
      return acc;
    },
    { budget: 0, actual: 0, variance: 0 }
  );
  return { periodId, budgetId, versionId, totals, lines: rows };
}

module.exports = {
  listBudgets,
  createBudget,
  getBudget,
  updateBudget,
  createVersion,
  upsertLines,
  getVariance,
};
