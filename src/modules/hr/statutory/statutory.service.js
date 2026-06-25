const repo = require("./statutory.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function createRule({ orgId, actorUserId, payload, audit, writeAudit }) {
  const p = { ...payload };
  if (p.brackets) {
    p.brackets_json = p.brackets;
    delete p.brackets;
  }
  const created = await repo.createRule(orgId, p);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.statutory_rule.created",
      entityType: "hr_statutory_rules",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return created;
}

async function listRules({ orgId, query }) {
  return repo.listRules(orgId, query);
}

async function getRule({ orgId, ruleId }) {
  const rule = await repo.getRule(orgId, ruleId);
  if (!rule) throw new AppError(404, "NOT_FOUND", "Statutory rule not found");
  return rule;
}

async function updateRule({ orgId, actorUserId, ruleId, payload, audit, writeAudit }) {
  const p = { ...payload };
  if (p.brackets) {
    p.brackets_json = p.brackets;
    delete p.brackets;
  }
  const updated = await repo.updateRule(orgId, ruleId, p);
  if (!updated) throw new AppError(404, "NOT_FOUND", "Statutory rule not found");
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.statutory_rule.updated",
      entityType: "hr_statutory_rules",
      entityId: updated.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return updated;
}

async function deactivateRule({ orgId, actorUserId, ruleId, audit, writeAudit }) {
  const updated = await repo.deactivateRule(orgId, ruleId);
  if (!updated) throw new AppError(404, "NOT_FOUND", "Statutory rule not found");
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.statutory_rule.deactivated",
      entityType: "hr_statutory_rules",
      entityId: updated.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
    });
  }
  return updated;
}

module.exports = { createRule, listRules, getRule, updateRule, deactivateRule };
