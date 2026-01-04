const { AppError } = require("../../shared/errors/AppError");
const repo = require("./kpis.repository");
const { trialBalance } = require("../../core/accounting/ledger/balances.service");
const { incomeStatement } = require("../financial-statements/financialStatements.service");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");

function assertCode(code) {
  if (!code || typeof code !== "string") throw new AppError(400, "code is required");
}

function assertName(name) {
  if (!name || typeof name !== "string") throw new AppError(400, "name is required");
}

function assertPeriodId(periodId) {
  if (!periodId) throw new AppError(400, "periodId is required");
}

async function listDefinitions({ orgId }) {
  return repo.listDefinitions({ orgId });
}

async function createDefinition({ orgId, code, name, description, dataType = "numeric", definitionJson = {}, status = "active", actorUserId, req }) {
  assertCode(code);
  assertName(name);
  if (!['numeric','text'].includes(dataType)) throw new AppError(400, "Invalid dataType");

  const created = await repo.createDefinition({ orgId, code, name, description, dataType, definitionJson, status });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.create",
    entityType: "kpi_definition",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });

  return created;
}

async function updateDefinition({ orgId, id, code, name, description, dataType, definitionJson, status, actorUserId, req }) {
  const before = await repo.getDefinition({ orgId, id });
  if (!before) throw new AppError(404, "KPI definition not found");

  const updated = await repo.updateDefinition({ orgId, id, code, name, description, dataType, definitionJson, status });
  if (!updated) throw new AppError(404, "KPI definition not found");

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.update",
    entityType: "kpi_definition",
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before,
    after: updated,
  });

  return updated;
}

async function deleteDefinition({ orgId, id, actorUserId, req }) {
  const before = await repo.getDefinition({ orgId, id });
  if (!before) throw new AppError(404, "KPI definition not found");
  await repo.deleteDefinition({ orgId, id });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.delete",
    entityType: "kpi_definition",
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before,
    after: null,
  });
}

// Supported calculation kinds (safe):
// 1) { kind: 'income_statement', metric: 'netIncome'|'totalRevenue'|'totalExpenses' }
// 2) { kind: 'account_type_sum', accountType: 'ASSET'|'LIABILITY'|'EQUITY'|'REVENUE'|'EXPENSE', normal: 'debit'|'credit' }
// 3) { kind: 'account_code_prefix_sum', prefix: '1'|'4000', normal: 'debit'|'credit' }
async function computeValues({ orgId, periodId }) {
  assertPeriodId(periodId);
  const defs = await repo.listDefinitions({ orgId });
  const tb = await trialBalance({ orgId, periodId });
  const is = await incomeStatement({ orgId, periodId });

  const getNormalAmount = (row, normal) => {
    const debit = Number(row.debit_total || 0);
    const credit = Number(row.credit_total || 0);
    return normal === "credit" ? (credit - debit) : (debit - credit);
  };

  const compute = (def) => {
    const d = def.definition_json || {};
    switch (d.kind) {
      case "income_statement": {
        const metric = d.metric;
        if (!metric || !is.totals || is.totals[metric] === undefined) return null;
        return { value_numeric: Number(is.totals[metric]), payload: { kind: d.kind, metric } };
      }
      case "account_type_sum": {
        const accountType = d.accountType;
        const normal = d.normal || (accountType === "ASSET" || accountType === "EXPENSE" ? "debit" : "credit");
        const rows = tb.filter((r) => r.account_type === accountType);
        const sum = rows.reduce((s, r) => s + getNormalAmount(r, normal), 0);
        return { value_numeric: sum, payload: { kind: d.kind, accountType, normal } };
      }
      case "account_code_prefix_sum": {
        const prefix = String(d.prefix || "");
        const normal = d.normal || "debit";
        if (!prefix) return null;
        const rows = tb.filter((r) => String(r.code).startsWith(prefix));
        const sum = rows.reduce((s, r) => s + getNormalAmount(r, normal), 0);
        return { value_numeric: sum, payload: { kind: d.kind, prefix, normal } };
      }
      default:
        return null;
    }
  };

  return defs
    .filter((d) => d.status === "active")
    .map((d) => {
      const c = compute(d);
      return {
        kpi_id: d.id,
        code: d.code,
        name: d.name,
        period_id: periodId,
        value_numeric: c ? c.value_numeric : null,
        payload_json: c ? c.payload : null,
      };
    });
}

async function computeAndPersistValues({ orgId, periodId, actorUserId, req }) {
  const computed = await computeValues({ orgId, periodId });
  const saved = [];

  for (const item of computed) {
    const row = await repo.upsertValue({
      orgId,
      kpiId: item.kpi_id,
      periodId,
      valueNumeric: item.value_numeric,
      valueText: null,
      payloadJson: item.payload_json || {},
    });
    saved.push(row);
  }

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.compute",
    entityType: "kpi_values",
    entityId: null,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { periodId, count: saved.length },
  });

  return saved;
}

module.exports = {
  listDefinitions,
  createDefinition,
  updateDefinition,
  deleteDefinition,
  computeValues,
  computeAndPersistValues,
};
