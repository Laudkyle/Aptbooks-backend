const { AppError } = require("../../../shared/errors/AppError"); 
const repo = require("./dimensionSecurity.repository"); 
const { writeAudit } = require("../audit-logs/audit.service"); 

function assertPrincipalType(v) {
  if (!v || !["user","role"].includes(v)) throw new AppError(400, "Invalid principalType"); 
}

function assertEffect(v) {
  if (!v || !["allow","deny"].includes(v)) throw new AppError(400, "Invalid effect"); 
}

async function listRules(ctx, { limit, offset }) {
  return repo.listRules({ organizationId: ctx.organizationId, limit, offset }); 
}

async function createRule(ctx, payload) {
  assertPrincipalType(payload.principalType); 
  if (!payload.principalId) throw new AppError(400, "principalId required"); 
  assertEffect(payload.effect); 
  const r = await repo.createRule({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    principalType: payload.principalType,
    principalId: payload.principalId,
    effect: payload.effect,
    ruleJson: payload.ruleJson || {},
    note: payload.note || null,
  }); 

  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "core.dimension_security.rule.create",
    entityType: "dimension_access_rule",
    entityId: r.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before: null,
    after: r,
  }); 

  return r; 
}

async function updateRule(ctx, ruleId, patch) {
  const before = await repo.getRule({ organizationId: ctx.organizationId, ruleId }); 
  if (!before) throw new AppError(404, "Rule not found"); 
  if (patch.principalType) assertPrincipalType(patch.principalType); 
  if (patch.effect) assertEffect(patch.effect); 

  const after = await repo.updateRule({ organizationId: ctx.organizationId, ruleId, patch }); 
  if (!after) throw new AppError(404, "Rule not found"); 

  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "core.dimension_security.rule.update",
    entityType: "dimension_access_rule",
    entityId: ruleId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before,
    after,
  }); 

  return after; 
}

async function deleteRule(ctx, ruleId) {
  const before = await repo.getRule({ organizationId: ctx.organizationId, ruleId }); 
  if (!before) throw new AppError(404, "Rule not found"); 
  const deleted = await repo.deleteRule({ organizationId: ctx.organizationId, ruleId }); 
  if (!deleted) throw new AppError(404, "Rule not found"); 

  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "core.dimension_security.rule.delete",
    entityType: "dimension_access_rule",
    entityId: ruleId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before,
    after: null,
  }); 

  return { id: ruleId }; 
}

module.exports = { listRules, createRule, updateRule, deleteRule }; 
