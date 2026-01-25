const repo = require("./grades.repository");
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

async function listGrades({ orgId, query }) { return repo.listGrades(orgId, query);}

async function exportGradesCsv({ orgId, query }) {
  const rows = await repo.listGrades(orgId, query || {});
  const headers = ["code","name","currency","min_amount","max_amount","status"];
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(","));
  return lines.join("\n");
}

async function importGrades({ orgId, actorUserId, grades, mode = "upsert", audit, writeAudit }) {
  if (!Array.isArray(grades) || !grades.length) throw new AppError(400, "grades must be a non-empty array");
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let idx = 0;idx < grades.length;idx += 1) {
    const row = grades[idx] || {};
    try {
      if (!row.code || !row.name) { results.skipped += 1;continue;}
      const existing = await repo.getGradeByCode(orgId, row.code);
      if (!existing) {
        if (mode === "update") { results.skipped += 1;continue;}
        await createGrade({ orgId, actorUserId, payload: row, audit, writeAudit });
        results.created += 1;
      } else {
        if (mode === "create") { results.skipped += 1;continue;}
        await updateGrade({ orgId, actorUserId, gradeId: existing.id, payload: row, audit, writeAudit });
        results.updated += 1;
      }
    } catch (e) {
      results.errors.push({ index: idx, code: row.code || null, message: e.message || String(e) });
    }
  }
  return results;
}

async function importGradesCsv({ orgId, actorUserId, csvText, mode = "upsert", audit, writeAudit }) {
  const rows = parseCsv(csvText);
  return importGrades({ orgId, actorUserId, grades: rows, mode, audit, writeAudit });
}

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

module.exports = {
  createGrade,
  listGrades,
  getGrade,
  updateGrade,
  deactivateGrade,
  exportGradesCsv,
  importGrades,
  importGradesCsv,
};
