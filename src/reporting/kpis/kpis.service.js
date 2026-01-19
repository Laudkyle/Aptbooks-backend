const repo = require("./kpis.repository");
const { AppError } = require("../../shared/errors/AppError");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const { assertUuid, assertCode, assertName } = require("../_util");

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

async function evalAst({ orgId, periodId, ast, cache }) {
  if (!ast || typeof ast !== "object") throw new AppError(400, "Invalid KPI expression AST");
  const kind = ast.kind;
  switch (kind) {
    case "const":
      if (typeof ast.value !== "number" || Number.isNaN(ast.value)) throw new AppError(400, "Invalid const value");
      return ast.value;
    case "account_balance": {
      const accountId = ast.accountId;
      assertUuid(accountId, "accountId");
      const key = `bal:${accountId}`;
      if (cache.has(key)) return cache.get(key);
      const v = await repo.getNormalisedAccountActual({ orgId, periodId, accountId });
      cache.set(key, v);
      return v;
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const a = await evalAst({ orgId, periodId, ast: ast.a, cache });
      const b = await evalAst({ orgId, periodId, ast: ast.b, cache });
      if (kind === "add") return a + b;
      if (kind === "sub") return a - b;
      if (kind === "mul") return a * b;
      if (kind === "div") {
        if (b === 0) throw new AppError(400, "Division by zero in KPI expression");
        return a / b;
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

    let value = 0;
    let meta = { source: "general_ledger_balances", kpi_type: def.kpi_type };

    if (def.kpi_type === "ACCOUNT_BALANCE") {
      value = await repo.getNormalisedAccountActual({ orgId, periodId, accountId: def.account_id });
      meta = { ...meta, account_id: def.account_id };
    } else if (def.kpi_type === "EXPRESSION") {
      const ast = def.expression;
      value = await evalAst({ orgId, periodId, ast, cache });
      meta = { ...meta, expression_kind: ast?.kind || null };
    } else {
      throw new AppError(400, `Unsupported KPI type: ${def.kpi_type}`);
    }

    if (Number.isNaN(value) || !Number.isFinite(value)) throw new AppError(400, "Computed KPI value is invalid");

    const target = await repo.getApplicableTarget({ orgId, kpiDefinitionId: id, periodId });
    if (target) {
      meta = {
        ...meta,
        target: {
          direction: target.direction,
          target_value: Number(target.target_value),
          amber_threshold: target.amber_threshold === null ? null : Number(target.amber_threshold),
          red_threshold: target.red_threshold === null ? null : Number(target.red_threshold),
        },
      };
    }

    const row = await repo.upsertValue({
      orgId,
      kpiDefinitionId: id,
      periodId,
      asOfDate: asOf,
      value,
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
    targetValue: Number(targetValue),
    amberThreshold: amberThreshold === undefined ? undefined : Number(amberThreshold),
    redThreshold: redThreshold === undefined ? undefined : Number(redThreshold),
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

module.exports = {
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
