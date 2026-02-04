const repo = require("./compBands.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function createBand({ orgId, actorUserId, payload, audit, writeAudit }) {
  const created = await repo.createBand(orgId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.comp_band.created",
      entityType: "hr_compensation_bands",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      after: created
    });
  }
  return created;
}

async function listBands({ orgId, query }) { return repo.listBands(orgId, query); }

async function getBand({ orgId, bandId }) {
  const b = await repo.getBand(orgId, bandId);
  if (!b) throw new AppError(404, "Compensation band not found");
  return b;
}

async function updateBand({ orgId, actorUserId, bandId, payload, audit, writeAudit }) {
  const before = await repo.getBand(orgId, bandId);
  if (!before) throw new AppError(404, "Compensation band not found");
  const updated = await repo.updateBand(orgId, bandId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.comp_band.updated",
      entityType: "hr_compensation_bands",
      entityId: bandId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      before,
      after: updated
    });
  }
  return updated;
}

async function deactivateBand({ orgId, actorUserId, bandId, audit, writeAudit }) {
  const before = await repo.getBand(orgId, bandId);
  if (!before) throw new AppError(404, "Compensation band not found");
  const updated = await repo.deactivateBand(orgId, bandId);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.comp_band.deactivated",
      entityType: "hr_compensation_bands",
      entityId: bandId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      before,
      after: updated
    });
  }
  return updated;
}

module.exports = { createBand, listBands, getBand, updateBand, deactivateBand };
