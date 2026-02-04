const repo = require("./positions.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function createPosition({ orgId, actorUserId, payload, audit, writeAudit }) {
  const created = await repo.createPosition(orgId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.position.created",
      entityType: "hr_positions",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      after: created
    });
  }
  return created;
}

async function listPositions({ orgId, query }) { return repo.listPositions(orgId, query); }

async function getPosition({ orgId, positionId }) {
  const p = await repo.getPosition(orgId, positionId);
  if (!p) throw new AppError(404, "Position not found");
  return p;
}

async function updatePosition({ orgId, actorUserId, positionId, payload, audit, writeAudit }) {
  const before = await repo.getPosition(orgId, positionId);
  if (!before) throw new AppError(404, "Position not found");
  const updated = await repo.updatePosition(orgId, positionId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.position.updated",
      entityType: "hr_positions",
      entityId: positionId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      before,
      after: updated
    });
  }
  return updated;
}

async function deactivatePosition({ orgId, actorUserId, positionId, audit, writeAudit }) {
  const before = await repo.getPosition(orgId, positionId);
  if (!before) throw new AppError(404, "Position not found");
  const updated = await repo.deactivatePosition(orgId, positionId);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.position.deactivated",
      entityType: "hr_positions",
      entityId: positionId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      before,
      after: updated
    });
  }
  return updated;
}

module.exports = { createPosition, listPositions, getPosition, updatePosition, deactivatePosition };
