const repo = require("./departments.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function createDepartment({ orgId, actorUserId, payload, audit, writeAudit }) {
  const created = await repo.createDepartment(orgId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.department.created",
      entityType: "hr_departments",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      after: created
    });
  }
  return created;
}

async function listDepartments({ orgId, query }) {
  return repo.listDepartments(orgId, query);
}

async function getDepartment({ orgId, departmentId }) {
  const dep = await repo.getDepartment(orgId, departmentId);
  if (!dep) throw new AppError(404, "Department not found");
  return dep;
}

async function updateDepartment({ orgId, actorUserId, departmentId, payload, audit, writeAudit }) {
  const before = await repo.getDepartment(orgId, departmentId);
  if (!before) throw new AppError(404, "Department not found");
  const updated = await repo.updateDepartment(orgId, departmentId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.department.updated",
      entityType: "hr_departments",
      entityId: departmentId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      before,
      after: updated
    });
  }
  return updated;
}

async function deactivateDepartment({ orgId, actorUserId, departmentId, audit, writeAudit }) {
  const before = await repo.getDepartment(orgId, departmentId);
  if (!before) throw new AppError(404, "Department not found");
  const updated = await repo.deactivateDepartment(orgId, departmentId);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.department.deactivated",
      entityType: "hr_departments",
      entityId: departmentId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      before,
      after: updated
    });
  }
  return updated;
}

module.exports = {
  createDepartment,
  listDepartments,
  getDepartment,
  updateDepartment,
  deactivateDepartment,
};
