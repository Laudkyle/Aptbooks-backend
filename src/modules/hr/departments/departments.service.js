const repo = require("./departments.repository"); 
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
  for (let i = 0;  i < line.length;  i += 1) {
    const ch = line[i]; 
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"';  i += 1;  }
        else inQ = false; 
      } else cur += ch; 
    } else {
      if (ch === '"') inQ = true; 
      else if (ch === ',') { out.push(cur);  cur = "";  }
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

async function exportDepartmentsCsv({ orgId, query }) {
  const rows = await repo.listDepartments(orgId, query || {}); 
  const headers = ["code", "name", "status"]; 
  const lines = [headers.join(",")]; 
  for (const r of rows) {
    lines.push(headers.map(h => csvEscape(r[h])).join(",")); 
  }
  return lines.join("\n"); 
}

async function importDepartments({ orgId, actorUserId, departments, mode = "upsert", audit, writeAudit }) {
  if (!Array.isArray(departments) || !departments.length) throw new AppError(400, "departments must be a non-empty array"); 
  const results = { created: 0, updated: 0, skipped: 0, errors: [] }; 
  for (let idx = 0;  idx < departments.length;  idx += 1) {
    const row = departments[idx] || {}; 
    try {
      if (!row.code || !row.name) { results.skipped += 1;  continue;  }
      const existing = await repo.getDepartmentByCode(orgId, row.code); 
      if (!existing) {
        if (mode === "update") { results.skipped += 1;  continue;  }
        await createDepartment({ orgId, actorUserId, payload: row, audit, writeAudit }); 
        results.created += 1; 
      } else {
        if (mode === "create") { results.skipped += 1;  continue;  }
        await updateDepartment({ orgId, actorUserId, departmentId: existing.id, payload: row, audit, writeAudit }); 
        results.updated += 1; 
      }
    } catch (e) {
      results.errors.push({ index: idx, code: row.code || null, message: e.message || String(e) }); 
    }
  }
  return results; 
}

async function importDepartmentsCsv({ orgId, actorUserId, csvText, mode = "upsert", audit, writeAudit }) {
  const rows = parseCsv(csvText); 
  return importDepartments({ orgId, actorUserId, departments: rows, mode, audit, writeAudit }); 
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
  exportDepartmentsCsv,
  importDepartments,
  importDepartmentsCsv,
}; 
