const repo = require("./benefits.repository");
const { AppError } = require("../../../shared/errors/AppError");

async function createBenefitPlan({ orgId, actorUserId, payload, audit, writeAudit }) {
  const created = await repo.createBenefitPlan(orgId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.benefit_plan.created",
      entityType: "hr_benefit_plans",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return created;
}

async function listBenefitPlans({ orgId, query }) {
  return repo.listBenefitPlans(orgId, query);
}

async function updateBenefitPlan({ orgId, actorUserId, planId, payload, audit, writeAudit }) {
  const updated = await repo.updateBenefitPlan(orgId, planId, payload);
  if (!updated) throw new AppError(404, "NOT_FOUND", "Benefit plan not found");
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.benefit_plan.updated",
      entityType: "hr_benefit_plans",
      entityId: updated.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return updated;
}

async function deactivateBenefitPlan({ orgId, actorUserId, planId, audit, writeAudit }) {
  const updated = await repo.deactivateBenefitPlan(orgId, planId);
  if (!updated) throw new AppError(404, "NOT_FOUND", "Benefit plan not found");
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.benefit_plan.deactivated",
      entityType: "hr_benefit_plans",
      entityId: updated.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
    });
  }
  return updated;
}

async function assignEmployeeBenefit({ orgId, actorUserId, payload, audit, writeAudit }) {
  const created = await repo.assignEmployeeBenefit(orgId, payload);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.employee_benefit.assigned",
      entityType: "hr_employee_benefits",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return created;
}

async function listEmployeeBenefits({ orgId, query }) {
  return repo.listEmployeeBenefits(orgId, query);
}

async function updateEmployeeBenefit({ orgId, actorUserId, employeeBenefitId, payload, audit, writeAudit }) {
  const updated = await repo.updateEmployeeBenefit(orgId, employeeBenefitId, payload);
  if (!updated) throw new AppError(404, "NOT_FOUND", "Employee benefit not found");
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.employee_benefit.updated",
      entityType: "hr_employee_benefits",
      entityId: updated.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return updated;
}

async function deactivateEmployeeBenefit({ orgId, actorUserId, employeeBenefitId, audit, writeAudit }) {
  const updated = await repo.deactivateEmployeeBenefit(orgId, employeeBenefitId);
  if (!updated) throw new AppError(404, "NOT_FOUND", "Employee benefit not found");
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.employee_benefit.deactivated",
      entityType: "hr_employee_benefits",
      entityId: updated.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
    });
  }
  return updated;
}

module.exports = {
  createBenefitPlan, listBenefitPlans, updateBenefitPlan, deactivateBenefitPlan,
  assignEmployeeBenefit, listEmployeeBenefits, updateEmployeeBenefit, deactivateEmployeeBenefit,
};
