const repo = require("./benefits.repository");
const { AppError } = require("../../../shared/errors/AppError");

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replaceAll('"', '""') + '"';
  }
  return s;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0;i < line.length;i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"';i += 1;}
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur);cur = "";}
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  if (typeof text !== "string" || !text.trim()) throw new AppError(400, "CSV body is required");
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new AppError(400, "CSV must include header and at least one row");
  const header = splitCsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1;i < lines.length;i += 1) {
    const cols = splitCsvLine(lines[i]);
    const obj = {};
    for (let j = 0;j < header.length;j += 1) obj[header[j]] = (cols[j] ?? "").trim();
    rows.push(obj);
  }
  return rows;
}

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

async function exportBenefitPlansCsv({ orgId, query }) {
  const rows = await repo.listBenefitPlans(orgId, query || {});
  const headers = ["code","name","description","employer_rate","employee_rate","base_on","cap_amount","expense_account_id","liability_account_id","status"];
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(","));
  return lines.join("\n");
}

async function importBenefitPlans({ orgId, actorUserId, plans, mode = "upsert", audit, writeAudit }) {
  if (!Array.isArray(plans) || !plans.length) throw new AppError(400, "plans must be a non-empty array");
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let idx = 0;idx < plans.length;idx += 1) {
    const row = plans[idx] || {};
    try {
      if (!row.code || !row.name) { results.skipped += 1;continue;}
      const existing = await repo.getBenefitPlanByCode(orgId, row.code);
      if (!existing) {
        if (mode === "update") { results.skipped += 1;continue;}
        await createBenefitPlan({ orgId, actorUserId, payload: row, audit, writeAudit });
        results.created += 1;
      } else {
        if (mode === "create") { results.skipped += 1;continue;}
        await updateBenefitPlan({ orgId, actorUserId, planId: existing.id, payload: row, audit, writeAudit });
        results.updated += 1;
      }
    } catch (e) {
      results.errors.push({ index: idx, code: row.code || null, message: e.message || String(e) });
    }
  }
  return results;
}

async function importBenefitPlansCsv({ orgId, actorUserId, csvText, mode = "upsert", audit, writeAudit }) {
  const rows = parseCsv(csvText);
  return importBenefitPlans({ orgId, actorUserId, plans: rows, mode, audit, writeAudit });
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
  createBenefitPlan,
  listBenefitPlans,
  updateBenefitPlan,
  deactivateBenefitPlan,
  exportBenefitPlansCsv,
  importBenefitPlans,
  importBenefitPlansCsv,
  assignEmployeeBenefit,
  listEmployeeBenefits,
  updateEmployeeBenefit,
  deactivateEmployeeBenefit,
};
