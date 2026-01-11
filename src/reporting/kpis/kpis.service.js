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

async function createDefinition({ orgId, code, name, description, expression, unit, status = "active", actorUserId, req }) {
  assertCode(code);
  assertName(name);
  if (!expression || typeof expression !== "string") throw new AppError(400, "expression is required");

  const created = await repo.createDefinition({ orgId, code, name, description, expression, unit, status });

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

async function updateDefinition({ orgId, id, code, name, description, expression, unit, status, actorUserId, req }) {
  const before = await repo.getDefinition({ orgId, id });
  if (!before) throw new AppError(404, "KPI definition not found");

  const updated = await repo.updateDefinition({ orgId, id, code, name, description, expression, unit, status });
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

// Supported expression formats (stored in kpi_definitions.expression):
// A) JSON string:
//    {"kind":"income_statement","metric":"netIncome"}
//    {"kind":"account_type_sum","accountType":"ASSET","normal":"debit"}
//    {"kind":"account_code_prefix_sum","prefix":"4000","normal":"credit"}
// B) Lightweight DSL:
//    income_statement.netIncome
//    account_type_sum:ASSET:debit
//    account_code_prefix_sum:4000:credit
function parseKpiExpression(expression) {
  if (!expression || typeof expression !== "string") return null;
  const expr = expression.trim();
  if (!expr) return null;

  // JSON format
  if (expr.startsWith("{")) {
    try {
      const obj = JSON.parse(expr);
      return obj && typeof obj === "object" ? obj : null;
    } catch {
      return null;
    }
  }

  // DSL format
  if (expr.startsWith("income_statement.")) {
    const metric = expr.split(".").slice(1).join(".");
    return metric ? { kind: "income_statement", metric } : null;
  }

  const parts = expr.split(":").map((p) => p.trim()).filter(Boolean);
  if (parts[0] === "account_type_sum") {
    const accountType = parts[1];
    const normal = parts[2] || undefined;
    return accountType ? { kind: "account_type_sum", accountType, normal } : null;
  }
  if (parts[0] === "account_code_prefix_sum") {
    const prefix = parts[1];
    const normal = parts[2] || undefined;
    return prefix ? { kind: "account_code_prefix_sum", prefix, normal } : null;
  }
  return null;
}

async function getPeriodAsOfDate({ orgId, periodId }) {
  const { pool } = require("../../db/pool");
  const { rows } = await pool.query(
    `SELECT end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(404, "Accounting period not found");
  return rows[0].end_date;
}

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
    const d = parseKpiExpression(def.expression);
    if (!d) return null;
    switch (d.kind) {
      case "income_statement": {
        const metric = d.metric;
        if (!metric || !is.totals || is.totals[metric] === undefined) return null;
        return { value: Number(is.totals[metric]), payload: { kind: d.kind, metric } };
      }
      case "account_type_sum": {
        const accountType = d.accountType;
        const normal = d.normal || (accountType === "ASSET" || accountType === "EXPENSE" ? "debit" : "credit");
        const rows = tb.filter((r) => r.account_type === accountType);
        const sum = rows.reduce((s, r) => s + getNormalAmount(r, normal), 0);
        return { value: sum, payload: { kind: d.kind, accountType, normal } };
      }
      case "account_code_prefix_sum": {
        const prefix = String(d.prefix || "");
        const normal = d.normal || "debit";
        if (!prefix) return null;
        const rows = tb.filter((r) => String(r.code).startsWith(prefix));
        const sum = rows.reduce((s, r) => s + getNormalAmount(r, normal), 0);
        return { value: sum, payload: { kind: d.kind, prefix, normal } };
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
        kpi_definition_id: d.id,
        code: d.code,
        name: d.name,
        period_id: periodId,
        value: c ? c.value : null,
        payload_json: c ? c.payload : null,
      };
    });
}

async function computeAndPersistValues({ orgId, periodId, actorUserId, req }) {
  const asOfDate = await getPeriodAsOfDate({ orgId, periodId });
  const computed = await computeValues({ orgId, periodId });
  const saved = [];

  for (const item of computed) {
    const row = await repo.upsertValue({
      orgId,
      kpiDefinitionId: item.kpi_definition_id,
      periodId,
      asOfDate,
      value: item.value,
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
