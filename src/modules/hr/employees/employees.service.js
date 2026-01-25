const repo = require("./employees.repository"); 
const { AppError } = require("../../../shared/errors/AppError"); 

async function createEmployee({ orgId, actorUserId, payload, audit, writeAudit }) {
  const created = await repo.createEmployee(orgId, payload); 
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.employee.created",
      entityType: "hr_employees",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      after: created
    }); 
  }
  return created; 
}

async function listEmployees({ orgId, query }) {
  return repo.listEmployees(orgId, query); 
}

async function getEmployee({ orgId, employeeId }) {
  const emp = await repo.getEmployee(orgId, employeeId); 
  if (!emp) throw new AppError(404, "Employee not found"); 
  return emp; 
}

async function updateEmployee({ orgId, actorUserId, employeeId, payload, audit, writeAudit }) {
  const before = await repo.getEmployee(orgId, employeeId); 
  if (!before) throw new AppError(404, "Employee not found"); 
  const updated = await repo.updateEmployee(orgId, employeeId, payload); 
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.employee.updated",
      entityType: "hr_employees",
      entityId: employeeId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      before,
      after: updated
    }); 
  }
  return updated; 
}

async function setStatus({ orgId, actorUserId, employeeId, status, audit, writeAudit }) {
  const before = await repo.getEmployee(orgId, employeeId); 
  if (!before) throw new AppError(404, "Employee not found"); 
  const updated = await repo.setEmployeeStatus(orgId, employeeId, status); 
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: `hr.employee.status.${status}`,
      entityType: "hr_employees",
      entityId: employeeId,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      before,
      after: updated
    }); 
  }
  return updated; 
}

function csvEscape(v) {
  if (v === null || v === undefined) return ""; 
  const s = String(v); 
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replaceAll('"', '""') + '"'; 
  }
  return s; 
}

async function exportEmployeesCsv({ orgId, query }) {
  const rows = await repo.listEmployees(orgId, query || {}); 
  const headers = [
    "employee_no","first_name","last_name","other_names","email","phone","hire_date","status",
    "department_id","position_id","grade_id","cost_center_id",
    "expense_account_id","payable_account_id",
    "compensation_band_id","base_salary_amount","base_salary_currency","base_salary_frequency",
    "bank_name","bank_account_no","bank_branch",
    "tax_id","national_id"
  ]; 
  const lines = [headers.join(",")]; 
  for (const r of rows) {
    const row = headers.map((h) => csvEscape(r[h])); 
    lines.push(row.join(",")); 
  }
  return lines.join("\n"); 
}

async function importEmployees({ orgId, actorUserId, employees, mode = "upsert", audit, writeAudit }) {
  if (!Array.isArray(employees) || !employees.length) {
    throw new AppError(400, "employees must be a non-empty array"); 
  }
  const results = { created: 0, updated: 0, skipped: 0, errors: [] }; 

  for (let idx = 0;  idx < employees.length;  idx += 1) {
    const row = employees[idx] || {}; 
    try {
      if (!row.employee_no || !row.first_name || !row.last_name) {
        results.skipped += 1; 
        continue; 
      }
      const existing = await repo.getEmployeeByNo(orgId, row.employee_no); 
      if (!existing) {
        if (mode === "update") { results.skipped += 1;  continue;  }
        await createEmployee({ orgId, actorUserId, payload: row, audit, writeAudit }); 
        results.created += 1; 
      } else {
        if (mode === "create") { results.skipped += 1;  continue;  }
        await updateEmployee({ orgId, actorUserId, employeeId: existing.id, payload: row, audit, writeAudit }); 
        results.updated += 1; 
      }
    } catch (e) {
      results.errors.push({ index: idx, employee_no: row.employee_no || null, message: e.message || String(e) }); 
    }
  }
  return results; 
}



function splitCsvLine(line) {
  const out = []; 
  let cur = ""; 
  let inQ = false; 
  for (let i = 0;  i < line.length;  i += 1) {
    const ch = line[i]; 
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"';  i += 1;  }
        else inQ = false; 
      } else {
        cur += ch; 
      }
    } else {
      if (ch === '"') inQ = true; 
      else if (ch === ",") { out.push(cur);  cur = "";  }
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
  for (let i = 1;  i < lines.length;  i += 1) {
    const cols = splitCsvLine(lines[i]); 
    const obj = {}; 
    for (let j = 0;  j < header.length;  j += 1) obj[header[j]] = (cols[j] ?? "").trim(); 
    rows.push(obj); 
  }
  return rows; 
}

function coerceNumber(v) {
  if (v === null || v === undefined) return undefined; 
  const s = String(v).trim(); 
  if (!s) return undefined; 
  const n = Number(s); 
  return Number.isFinite(n) ? n : undefined; 
}

async function importEmployeesCsv({ orgId, actorUserId, csvText, mode = "upsert", audit, writeAudit }) {
  const rows = parseCsv(csvText); 
  // Normalize common numeric fields if present
  const employees = rows.map((r) => ({
    ...r,
    base_salary_amount: coerceNumber(r.base_salary_amount) ?? coerceNumber(r.base_salary),
    cost_center_id: r.cost_center_id || r.cost_center || undefined,
    expense_account_id: r.expense_account_id || undefined,
    payable_account_id: r.payable_account_id || undefined,
  })); 
  return importEmployees({ orgId, actorUserId, employees, mode, audit, writeAudit }); 
}

module.exports = {
  createEmployee,
  listEmployees,
  getEmployee,
  updateEmployee,
  setStatus,
  exportEmployeesCsv,
  importEmployees,
  importEmployeesCsv,
}; 
