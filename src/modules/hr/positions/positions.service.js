const repo = require("./positions.repository");
const { AppError } = require("../../../shared/errors/AppError");
const departmentsRepo = require("../departments/departments.repository");
const gradesRepo = require("../grades/grades.repository");

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
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ""; }
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
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitCsvLine(lines[i]);
    const obj = {};
    for (let j = 0; j < header.length; j += 1) obj[header[j]] = (cols[j] ?? "").trim();
    rows.push(obj);
  }
  return rows;
}

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

async function exportPositionsCsv({ orgId, query }) {
  const rows = await repo.listPositions(orgId, query || {});
  const headers = ["code","name","department_code","grade_code","status"];
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(","));
  return lines.join("\n");
}

async function importPositions({ orgId, actorUserId, positions, mode = "upsert", audit, writeAudit }) {
  if (!Array.isArray(positions) || !positions.length) throw new AppError(400, "positions must be a non-empty array");
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let idx = 0; idx < positions.length; idx += 1) {
    const row0 = positions[idx] || {};
    try {
      if (!row0.code || !row0.name) { results.skipped += 1; continue; }
      const row = { ...row0 };
      // Resolve department/grade IDs from codes if provided
      if (!row.department_id && row.department_code) {
        const d = await departmentsRepo.getDepartmentByCode(orgId, row.department_code);
        if (d) row.department_id = d.id;
      }
      if (!row.grade_id && row.grade_code) {
        const g = await gradesRepo.getGradeByCode(orgId, row.grade_code);
        if (g) row.grade_id = g.id;
      }
      const existing = await repo.getPositionByCode(orgId, row.code);
      if (!existing) {
        if (mode === "update") { results.skipped += 1; continue; }
        await createPosition({ orgId, actorUserId, payload: row, audit, writeAudit });
        results.created += 1;
      } else {
        if (mode === "create") { results.skipped += 1; continue; }
        await updatePosition({ orgId, actorUserId, positionId: existing.id, payload: row, audit, writeAudit });
        results.updated += 1;
      }
    } catch (e) {
      results.errors.push({ index: idx, code: row0.code || null, message: e.message || String(e) });
    }
  }
  return results;
}

async function importPositionsCsv({ orgId, actorUserId, csvText, mode = "upsert", audit, writeAudit }) {
  const rows = parseCsv(csvText);
  return importPositions({ orgId, actorUserId, positions: rows, mode, audit, writeAudit });
}

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

module.exports = {
  createPosition,
  listPositions,
  getPosition,
  updatePosition,
  deactivatePosition,
  exportPositionsCsv,
  importPositions,
  importPositionsCsv,
};
