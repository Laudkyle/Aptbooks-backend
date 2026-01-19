const { AppError } = require("../../shared/errors/AppError");
const repo = require("./budgets.repository");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const { validateDimensionJson } = require("../dimensions/dimensions.validator");

function assertName(name) {
  if (!name || typeof name !== "string") throw new AppError(400, "name is required");
}


function assertBudgetStatus(status) {
  if (!status) return;
  const allowed = new Set(["draft", "active", "archived"]);
  if (!allowed.has(status)) throw new AppError(400, `Invalid budget status. Allowed: ${Array.from(allowed).join(", ")}`);
}

function assertVersionStatus(status) {
  if (!status) return;
  const allowed = new Set(["draft", "final", "archived"]);
  if (!allowed.has(status)) throw new AppError(400, `Invalid version status. Allowed: ${Array.from(allowed).join(", ")}`);
}

function roundMoney(v, decimals = 2) {
  const m = Math.pow(10, decimals);
  return Math.round((Number(v) + Number.EPSILON) * m) / m;
}

async function resolveAndValidatePeriods({ orgId, budget, periodIds }) {
  if (Array.isArray(periodIds) && periodIds.length) {
    // validate each period exists in org
    const periods = [];
    for (const pid of periodIds) {
      const p = await repo.getAccountingPeriod({ orgId, periodId: pid });
      if (!p) throw new AppError(400, `Invalid periodId: ${pid}`);
      periods.push(p);
    }
    return periods.sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  }

  if (!budget.fiscal_year) {
    throw new AppError(400, "periodIds is required when budget.fiscalYear is not set");
  }

  const periods = await repo.listPeriodsByStartYear({ orgId, year: Number(budget.fiscal_year) });
  if (!periods.length) throw new AppError(400, `No accounting periods found for fiscalYear ${budget.fiscal_year}`);
  return periods;
}
async function listBudgets({ orgId }) {
  return repo.listBudgets({ orgId });
}

async function createBudget({ orgId, name, fiscalYear, currencyCode, status, actorUserId, req }) {
  assertName(name);
  if (!currencyCode) throw new AppError(400, "currencyCode is required");
  assertBudgetStatus(status);
  const created = await repo.createBudget({ orgId, name, fiscalYear, currencyCode, status: status || "draft" });

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

  assertBudgetStatus(status);
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
  assertVersionStatus(status);
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
  assertEditableWorkflow(v);
  const budget = await getBudget({ orgId, id: budgetId });
  if (!Array.isArray(lines)) throw new AppError(400, "lines must be an array");

  const saved = [];
  for (const line of lines) {
    if (!line.accountId) throw new AppError(400, "Each line requires accountId");
    if (!line.periodId) throw new AppError(400, "Each line requires periodId");
    if (line.amount === undefined || line.amount === null) throw new AppError(400, "Each line requires amount");

    const p = await repo.getAccountingPeriod({ orgId, periodId: line.periodId });
    if (!p) throw new AppError(400, `Invalid periodId: ${line.periodId}`);
    if (budget.fiscal_year) {
      const y = new Date(p.start_date).getUTCFullYear();
      if (Number(y) !== Number(budget.fiscal_year)) {
        throw new AppError(400, `periodId ${line.periodId} is not in budget fiscalYear ${budget.fiscal_year}`);
      }
    }
    const amountNum = Number(line.amount);
    if (Number.isNaN(amountNum)) throw new AppError(400, "Each line amount must be numeric");
    const dim = await validateDimensionJson({ orgId, dimensionJson: line.dimensionJson || {} });

    const row = await repo.upsertLine({
      orgId,
      versionId,
      accountId: line.accountId,
      periodId: line.periodId,
      amount: amountNum,
      dimensionJson: dim,
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

function assertEditableWorkflow(version) {
  if (!version) throw new AppError(404, "Budget version not found");
  const locked = new Set(["approved", "archived"]);
  if (locked.has(version.workflow_status)) {
    throw new AppError(409, `Version workflow_status '${version.workflow_status}' is not editable`);
  }
}

async function submitVersion({ orgId, budgetId, versionId, actorUserId, req }) {
  const v = await repo.getVersion({ orgId, budgetId, versionId });
  if (!v) throw new AppError(404, "Budget version not found");
  if (v.workflow_status !== "draft" && v.workflow_status !== "rejected") {
    throw new AppError(409, "Only draft/rejected versions can be submitted");
  }
  const updated = await repo.updateVersionWorkflow({
    orgId,
    budgetId,
    versionId,
    patch: {
      workflowStatus: "in_review",
      submittedAt: new Date().toISOString(),
      submittedByUserId: actorUserId,
      rejectionReason: null,
    },
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.version.submit",
    entityType: "budget_version",
    entityId: versionId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: v,
    after: updated,
  });
  return updated;
}

async function approveVersion({ orgId, budgetId, versionId, actorUserId, req }) {
  const v = await repo.getVersion({ orgId, budgetId, versionId });
  if (!v) throw new AppError(404, "Budget version not found");
  if (v.workflow_status !== "in_review") throw new AppError(409, "Only in_review versions can be approved");
  const updated = await repo.updateVersionWorkflow({
    orgId,
    budgetId,
    versionId,
    patch: {
      workflowStatus: "approved",
      approvedAt: new Date().toISOString(),
      approvedByUserId: actorUserId,
    },
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.version.approve",
    entityType: "budget_version",
    entityId: versionId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: v,
    after: updated,
  });
  return updated;
}

async function rejectVersion({ orgId, budgetId, versionId, reason, actorUserId, req }) {
  const v = await repo.getVersion({ orgId, budgetId, versionId });
  if (!v) throw new AppError(404, "Budget version not found");
  if (v.workflow_status !== "in_review") throw new AppError(409, "Only in_review versions can be rejected");
  const updated = await repo.updateVersionWorkflow({
    orgId,
    budgetId,
    versionId,
    patch: {
      workflowStatus: "rejected",
      rejectedAt: new Date().toISOString(),
      rejectedByUserId: actorUserId,
      rejectionReason: reason || "Rejected",
    },
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.version.reject",
    entityType: "budget_version",
    entityId: versionId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: v,
    after: updated,
  });
  return updated;
}

async function copyVersion({ orgId, budgetId, sourceVersionId, newVersionNo, name, scenarioKey, actorUserId, req }) {
  const source = await repo.getVersion({ orgId, budgetId, versionId: sourceVersionId });
  if (!source) throw new AppError(404, "Source budget version not found");
  const created = await repo.copyVersion({
    orgId,
    budgetId,
    sourceVersionId,
    newVersionNo,
    name,
    scenarioKey,
    createdByUserId: actorUserId,
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.version.copy",
    entityType: "budget_version",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { sourceVersionId, created },
  });
  return created;
}

async function massAdjustLines({ orgId, budgetId, versionId, pct, accountId, periodId, dimensionJson, actorUserId, req }) {
  const v = await repo.getVersion({ orgId, budgetId, versionId });
  assertEditableWorkflow(v);
  const dim = dimensionJson ? await validateDimensionJson({ orgId, dimensionJson }) : null;
  const result = await repo.massAdjustLines({ orgId, versionId, pct, accountId, periodId, dimensionJson: dim });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.lines.mass_adjust",
    entityType: "budget_lines",
    entityId: null,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { budgetId, versionId, pct, accountId, periodId, affected: result.affected },
  });
  return result;
}

async function listAlertRules({ orgId, budgetId }) {
  return repo.listAlertRules({ orgId, budgetId });
}

async function createAlertRule({ orgId, budgetId, name, thresholdPct, accountId, dimensionJson, isEnabled, actorUserId, req }) {
  if (!name) throw new AppError(400, "name is required");
  if (thresholdPct === undefined || thresholdPct === null) throw new AppError(400, "thresholdPct is required");
  const dim = await validateDimensionJson({ orgId, dimensionJson: dimensionJson || {} });
  const created = await repo.createAlertRule({ orgId, budgetId, name, thresholdPct, accountId, dimensionJson: dim, isEnabled });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.alert_rule.create",
    entityType: "budget_alert_rule",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });
  return created;
}

async function updateAlertRule({ orgId, budgetId, ruleId, patch, actorUserId, req }) {
  const before = await repo.getAlertRule({ orgId, budgetId, ruleId });
  if (!before) throw new AppError(404, "Alert rule not found");
  const dim = patch && patch.dimensionJson ? await validateDimensionJson({ orgId, dimensionJson: patch.dimensionJson }) : undefined;
  const updated = await repo.updateAlertRule({
    orgId,
    budgetId,
    ruleId,
    patch: { ...patch, dimensionJson: dim === undefined ? undefined : dim },
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.alert_rule.update",
    entityType: "budget_alert_rule",
    entityId: ruleId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before,
    after: updated,
  });
  return updated;
}

async function getVariance({ orgId, budgetId, versionId, periodId }) {
  if (!periodId) throw new AppError(400, "periodId is required");
  const v = await repo.getVersion({ orgId, budgetId, versionId });
  if (!v) throw new AppError(404, "Budget version not found");
  const budget = await getBudget({ orgId, id: budgetId });

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


async function distributeAnnual({ orgId, budgetId, versionId, items, actorUserId, req }) {
  const v = await repo.getVersion({ orgId, budgetId, versionId });
  if (!v) throw new AppError(404, "Budget version not found");

  const budget = await getBudget({ orgId, id: budgetId });
  const payloadItems = Array.isArray(items) ? items : [];
  if (!payloadItems.length) throw new AppError(400, "items must be a non-empty array");

  const saved = [];
  for (const it of payloadItems) {
    const { accountId, annualAmount, method, periodIds, weights, amounts, dimensionJson } = it || {};
    if (!accountId) throw new AppError(400, "Each item requires accountId");
    if (annualAmount === undefined || annualAmount === null) throw new AppError(400, "Each item requires annualAmount");
    const m = (method || "even").toLowerCase();
    if (!["even", "weighted", "custom"].includes(m)) throw new AppError(400, "method must be one of: even, weighted, custom");

    const periods = await resolveAndValidatePeriods({ orgId, budget, periodIds });
    const n = periods.length;

    let perPeriodAmounts = [];

    if (m === "even") {
      const total = Number(annualAmount);
      const raw = total / n;
      let running = 0;
      for (let i = 0; i < n; i++) {
        const a = (i === n - 1) ? roundMoney(total - running, 2) : roundMoney(raw, 2);
        running = roundMoney(running + a, 2);
        perPeriodAmounts.push(a);
      }
    } else if (m === "weighted") {
      if (!Array.isArray(weights) || weights.length !== n) throw new AppError(400, "weights must be an array aligned to periodIds (same length)");
      const wsum = weights.reduce((acc, w) => acc + Number(w || 0), 0);
      if (!wsum) throw new AppError(400, "weights sum must be > 0");
      const total = Number(annualAmount);
      let running = 0;
      for (let i = 0; i < n; i++) {
        const share = total * (Number(weights[i]) / wsum);
        const a = (i === n - 1) ? roundMoney(total - running, 2) : roundMoney(share, 2);
        running = roundMoney(running + a, 2);
        perPeriodAmounts.push(a);
      }
    } else {
      if (!Array.isArray(amounts) || amounts.length !== n) throw new AppError(400, "amounts must be an array aligned to periodIds (same length)");
      perPeriodAmounts = amounts.map((x) => roundMoney(x, 2));
    }

    const dim = await validateDimensionJson({ orgId, dimensionJson: dimensionJson || {} });

    // upsert per period
    for (let i = 0; i < n; i++) {
      const p = periods[i];
      const amountNum = Number(perPeriodAmounts[i]);
      if (Number.isNaN(amountNum)) throw new AppError(400, "Computed budget amount must be numeric");
      const row = await repo.upsertLine({
        orgId,
        versionId,
        accountId,
        periodId: p.id,
        amount: amountNum,
        dimensionJson: dim,
      });
      saved.push(row);
    }
  }

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.lines.distribute",
    entityType: "budget_lines",
    entityId: null,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { budgetId, versionId, count: saved.length },
  });

  return saved;
}

async function finalizeVersion({ orgId, budgetId, versionId, actorUserId, req }) {
  const v = await repo.getVersion({ orgId, budgetId, versionId });
  if (!v) throw new AppError(404, "Budget version not found");
  if (v.status !== "draft") throw new AppError(409, "Only draft versions can be finalized");

  const { pool } = require("../../db/pool");
  const { rows } = await pool.query(
    `
    UPDATE budget_versions
    SET status='final', updated_at=NOW()
    WHERE organization_id=$1 AND budget_id=$2 AND id=$3 AND status='draft'
    RETURNING id, budget_id, version_no, name, status, updated_at
    `,
    [orgId, budgetId, versionId]
  );

  const updated = rows[0];

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.budget.version.finalize",
    entityType: "budget_version",
    entityId: versionId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: v,
    after: updated,
  });

  return updated;
}

module.exports = {
  listBudgets,
  createBudget,
  getBudget,
  updateBudget,
  createVersion,
  upsertLines,
  getVariance,
  distributeAnnual,
  finalizeVersion,
  submitVersion,
  approveVersion,
  rejectVersion,
  copyVersion,
  massAdjustLines,
  listAlertRules,
  createAlertRule,
  updateAlertRule,
};
