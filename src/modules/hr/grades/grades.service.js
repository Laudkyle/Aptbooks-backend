const repo = require("./grades.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function createGrade({ orgId, actorUserId, payload, audit, writeAudit }) {
  const created = await repo.createGrade(orgId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.grade.created",
      entityType: "hr_grades",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      after: created
    });
  }
  return created;
}

async function listGrades({ orgId, query }) { return repo.listGrades(orgId, query); }

async function getGrade({ orgId, gradeId }) {
  const g = await repo.getGrade(orgId, gradeId);
  if (!g) throw new AppError(404, "Grade not found");
  return g;
}

async function updateGrade({ orgId, actorUserId, gradeId, payload, audit, writeAudit }) {
  const before = await repo.getGrade(orgId, gradeId);
  if (!before) throw new AppError(404, "Grade not found");
  const updated = await repo.updateGrade(orgId, gradeId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.grade.updated",
      entityType: "hr_grades",
      entityId: gradeId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      before,
      after: updated
    });
  }
  return updated;
}

async function deactivateGrade({ orgId, actorUserId, gradeId, audit, writeAudit }) {
  const before = await repo.getGrade(orgId, gradeId);
  if (!before) throw new AppError(404, "Grade not found");
  const updated = await repo.deactivateGrade(orgId, gradeId);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.grade.deactivated",
      entityType: "hr_grades",
      entityId: gradeId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      before,
      after: updated
    });
  }
  return updated;
}

module.exports = { createGrade, listGrades, getGrade, updateGrade, deactivateGrade };
