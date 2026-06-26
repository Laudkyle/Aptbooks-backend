const repo = require("./kpis.repository");
const { AppError } = require("../../shared/errors/AppError");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const { assertUuid, assertCode, assertName, toDecimal, decimalToMoneyString, Decimal } = require("../_util");
const { parseCsvText } = require("../../shared/utils/csv");

const KPI_TYPES = ["ACCOUNT_BALANCE", "EXPRESSION"];
const KPI_STATUS = ["active", "archived"];

function assertEnum(v, allowed, label) {
  if (!allowed.includes(v)) throw new AppError(400, `${label} must be one of: ${allowed.join(", ")}`);
}

function parseExpressionJson(input) {
  if (!input) return null;
  if (typeof input === "object") return input;
  // Only accept JSON text; never eval.
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      throw new AppError(400, "expressionJson must be valid JSON");
    }
  }
  throw new AppError(400, "expressionJson must be an object or JSON string");
}

function validateExpressionAst(ast, depth = 0) {
  if (!ast || typeof ast !== "object" || Array.isArray(ast)) throw new AppError(400, "Invalid KPI expression AST");
  if (depth > 20) throw new AppError(400, "KPI expression is too deeply nested");
  const kind = ast.kind;
  if (!["const", "account_balance", "add", "sub", "mul", "div"].includes(kind)) {
    throw new AppError(400, `Unsupported KPI expression kind: ${kind}`);
  }
  if (kind === "const") {
    toDecimal(ast.value, "const.value");
    return ast;
  }
  if (kind === "account_balance") {
    assertUuid(ast.accountId, "accountId");
    return ast;
  }
  validateExpressionAst(ast.a, depth + 1);
  validateExpressionAst(ast.b, depth + 1);
  return ast;
}

async function evalAst({ orgId, periodId, ast, cache }) {
  if (!ast || typeof ast !== "object") throw new AppError(400, "Invalid KPI expression AST");
  const kind = ast.kind;
  switch (kind) {
    case "const":
      return toDecimal(ast.value, "const.value");
    case "account_balance": {
      const accountId = ast.accountId;
      assertUuid(accountId, "accountId");
      const key = `bal:${accountId}`;
      if (cache.has(key)) return cache.get(key);
      const v = await repo.getNormalisedAccountActual({ orgId, periodId, accountId });
      const out = toDecimal(v || 0, "account balance");
      cache.set(key, out);
      return out;
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const a = await evalAst({ orgId, periodId, ast: ast.a, cache });
      const b = await evalAst({ orgId, periodId, ast: ast.b, cache });
      if (kind === "add") return a.plus(b);
      if (kind === "sub") return a.minus(b);
      if (kind === "mul") return a.times(b);
      if (kind === "div") {
        if (b.isZero()) throw new AppError(400, "Division by zero in KPI expression");
        return a.dividedBy(b);
      }
      break;
    }
    default:
      throw new AppError(400, `Unsupported KPI expression kind: ${kind}`);
  }
}

async function listDefinitions({ orgId, status, limit, offset }) {
  return repo.listDefinitions({ orgId, status: status || null, limit, offset });
}

async function createDefinition({ orgId, actorUserId, req, code, name, kpiType, accountId, status, expressionJson, category, ownerUserId, documentation }) {
  assertCode(code, "code");
  assertName(name, "name");
  assertEnum(kpiType, KPI_TYPES, "kpiType");
  assertEnum(status || "active", KPI_STATUS, "status");
  if (kpiType === "ACCOUNT_BALANCE") {
    assertUuid(accountId, "accountId");
  }
  const expr = parseExpressionJson(expressionJson);
  if (kpiType === "EXPRESSION" && !expr) {
    throw new AppError(400, "expressionJson is required for EXPRESSION KPIs");
  }
  if (expr) validateExpressionAst(expr);
  const created = await repo.createDefinition({
    orgId,
    code: code.trim(),
    name: name.trim(),
    kpiType,
    status: status || "active",
    accountId: accountId || null,
    expressionJson: expr,
    category: category || null,
    ownerUserId: ownerUserId || null,
    documentation: documentation || null,
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.definition.create",
    entityType: "kpi_definition",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });

  return created;
}

async function updateDefinition({ orgId, actorUserId, req, id, patch }) {
  assertUuid(id, "id");
  const existing = await repo.getDefinition({ orgId, id });
  if (!existing) throw new AppError(404, "KPI definition not found");

  const outPatch = {};
  if (patch.code !== undefined) {
    assertCode(patch.code, "code");
    outPatch.code = patch.code.trim();
  }
  if (patch.name !== undefined) {
    assertName(patch.name, "name");
    outPatch.name = patch.name.trim();
  }
  if (patch.status !== undefined) {
    assertEnum(patch.status, KPI_STATUS, "status");
    outPatch.status = patch.status;
  }
  if (patch.kpiType !== undefined) {
    assertEnum(patch.kpiType, KPI_TYPES, "kpiType");
    outPatch.kpiType = patch.kpiType;
  }
  if (patch.accountId !== undefined) {
    if (patch.accountId !== null) assertUuid(patch.accountId, "accountId");
    outPatch.accountId = patch.accountId;
  }
  if (patch.expressionJson !== undefined) {
    outPatch.expressionJson = parseExpressionJson(patch.expressionJson);
    if (outPatch.expressionJson) validateExpressionAst(outPatch.expressionJson);
  }
  if (patch.category !== undefined) {
    outPatch.category = patch.category;
  }
  if (patch.ownerUserId !== undefined) {
    if (patch.ownerUserId !== null) assertUuid(patch.ownerUserId, "ownerUserId");
    outPatch.ownerUserId = patch.ownerUserId;
  }
  if (patch.documentation !== undefined) {
    outPatch.documentation = patch.documentation;
  }
  const updated = await repo.updateDefinition({ orgId, id, patch: outPatch });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.definition.update",
    entityType: "kpi_definition",
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: existing,
    after: updated,
  });
  return updated;
}

async function archiveDefinition({ orgId, actorUserId, req, id }) {
  assertUuid(id, "id");
  const existing = await repo.getDefinition({ orgId, id });
  if (!existing) throw new AppError(404, "KPI definition not found");
  const archived = await repo.archiveDefinition({ orgId, id });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.definition.archive",
    entityType: "kpi_definition",
    entityId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: existing,
    after: archived,
  });
  return archived;
}

async function computeValues({ orgId, actorUserId, req, periodId, kpiDefinitionIds, asOfDate = null }) {
  assertUuid(periodId, "periodId");
  if (!Array.isArray(kpiDefinitionIds) || !kpiDefinitionIds.length) {
    throw new AppError(400, "kpiDefinitionIds must be a non-empty array");
  }
  const ids = kpiDefinitionIds.map((id) => {
    assertUuid(id, "kpiDefinitionId");
    return id;
  });
  const date = asOfDate ? new Date(asOfDate) : new Date();
  if (Number.isNaN(date.getTime())) throw new AppError(400, "asOfDate must be a valid date");
  const asOf = date.toISOString().slice(0, 10); // store as date

  const cache = new Map();
  const computed = [];

  for (const id of ids) {
    const def = await repo.getDefinition({ orgId, id });
    if (!def) throw new AppError(404, `KPI definition not found: ${id}`);
    if (def.status !== "active") throw new AppError(409, `KPI definition is not active: ${def.code}`);

    let value = new Decimal(0);
    let meta = { source: "general_ledger_balances", kpi_type: def.kpi_type };

    if (def.kpi_type === "ACCOUNT_BALANCE") {
      value = toDecimal(await repo.getNormalisedAccountActual({ orgId, periodId, accountId: def.account_id }) || 0, "KPI value");
      meta = { ...meta, account_id: def.account_id };
    } else if (def.kpi_type === "EXPRESSION") {
      const ast = def.expression;
      value = await evalAst({ orgId, periodId, ast, cache });
      meta = { ...meta, expression_kind: ast?.kind || null };
    } else {
      throw new AppError(400, `Unsupported KPI type: ${def.kpi_type}`);
    }

    if (!value.isFinite()) throw new AppError(400, "Computed KPI value is invalid");

    const target = await repo.getApplicableTarget({ orgId, kpiDefinitionId: id, periodId });
    if (target) {
      meta = {
        ...meta,
        target: {
          direction: target.direction,
          target_value: decimalToMoneyString(target.target_value, 2),
          amber_threshold: target.amber_threshold === null ? null : decimalToMoneyString(target.amber_threshold, 2),
          red_threshold: target.red_threshold === null ? null : decimalToMoneyString(target.red_threshold, 2),
        },
      };
    }

    const row = await repo.upsertValue({
      orgId,
      kpiDefinitionId: id,
      periodId,
      asOfDate: asOf,
      value: decimalToMoneyString(value, 2),
      metaJson: meta,
    });
    computed.push(row);
  }

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.values.compute",
    entityType: "kpi_values",
    entityId: null,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { periodId, count: computed.length, asOfDate: asOf },
  });

  return { periodId, asOfDate: asOf, count: computed.length, values: computed };
}

async function listValues({ orgId, periodId, limit, offset }) {
  if (periodId) assertUuid(periodId, "periodId");
  return repo.listValues({ orgId, periodId: periodId || null, limit, offset });
}

// KPI Targets
async function listTargets({ orgId, kpiDefinitionId, includeArchived = false }) {
  assertUuid(kpiDefinitionId, "kpiDefinitionId");
  return repo.listTargets({ orgId, kpiDefinitionId, includeArchived });
}

async function createTarget({ orgId, actorUserId, req, kpiDefinitionId, periodId, direction = "higher", targetValue, amberThreshold, redThreshold }) {
  assertUuid(kpiDefinitionId, "kpiDefinitionId");
  if (periodId !== undefined && periodId !== null) assertUuid(periodId, "periodId");
  if (!targetValue && targetValue !== 0) throw new AppError(400, "targetValue is required");
  if (!["higher", "lower"].includes(direction)) throw new AppError(400, "direction must be 'higher' or 'lower'");
  const created = await repo.upsertTarget({
    orgId,
    kpiDefinitionId,
    periodId: periodId || null,
    direction,
    targetValue: decimalToMoneyString(targetValue, 2),
    amberThreshold: amberThreshold === undefined ? undefined : decimalToMoneyString(amberThreshold, 2),
    redThreshold: redThreshold === undefined ? undefined : decimalToMoneyString(redThreshold, 2),
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.target.create",
    entityType: "kpi_target",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: created,
  });
  return created;
}

async function updateTarget({ orgId, actorUserId, req, targetId, patch }) {
  assertUuid(targetId, "targetId");
  const before = await repo.getTarget({ orgId, id: targetId });
  if (!before) throw new AppError(404, "KPI target not found");
  const updated = await repo.updateTarget({ orgId, id: targetId, patch });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.target.update",
    entityType: "kpi_target",
    entityId: targetId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before,
    after: updated,
  });
  return updated;
}

async function archiveTarget({ orgId, actorUserId, req, targetId }) {
  return updateTarget({ orgId, actorUserId, req, targetId, patch: { isArchived: true } });
}


async function importValuesCsv({ orgId, csvText, actorUserId, req }) {
  const rows = parseCsvText(csvText);
  const values = [];
  for (const r of rows) {
    const kpiDefinitionId = (r.kpiDefinitionId || r.kpi_definition_id || r.kpi_definitionId || "").trim();
    const kpiCode = (r.kpiCode || r.kpi_code || r.code || "").trim();
    const periodId = (r.periodId || r.period_id || "").trim();
    const valueRaw = (r.value || r.kpi_value || "").trim();
    const asOfDate = (r.asOfDate || r.as_of_date || r.asOf || "").trim();
    const metaRaw = (r.metaJson || r.meta_json || r.meta || "").trim();
    if (!periodId) throw new AppError(400, "periodId is required in CSV");
    if (!valueRaw) throw new AppError(400, "value is required in CSV");
    let defId = kpiDefinitionId;
    if (!defId && kpiCode) {
      const def = await repo.getDefinitionByCode({ orgId, code: kpiCode });
      if (!def) throw new AppError(400, `Unknown KPI code: ${kpiCode}`);
      defId = def.id;
    }
    if (!defId) throw new AppError(400, "kpiDefinitionId or kpiCode is required in CSV");
    assertUuid(defId, "kpiDefinitionId");
    assertUuid(periodId, "periodId");
    const num = decimalToMoneyString(valueRaw, 2);
    let metaJson = null;
    if (metaRaw) {
      try { metaJson = JSON.parse(metaRaw); } catch (e) { throw new AppError(400, "metaJson must be valid JSON"); }
    }
    const row = await repo.upsertValue({
      orgId,
      kpiDefinitionId: defId,
      periodId,
      asOfDate: asOfDate || null,
      value: num,
      metaJson: metaJson || { source: "csv_import" },
    });
    values.push(row);
  }
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.kpi.values.import_csv",
    entityType: "kpi_values",
    entityId: null,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { count: values.length },
  });
  return { count: values.length, values };
}
module.exports = {
  importValuesCsv,
  listDefinitions,
  createDefinition,
  updateDefinition,
  archiveDefinition,
  computeValues,
  listValues,
  listTargets,
  createTarget,
  updateTarget,
  archiveTarget,
};
