const repo = require("./compBands.repository");
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

function coerceNumber(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

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

async function exportBandsCsv({ orgId, query }) {
  const rows = await repo.listBands(orgId, query || {});
  const headers = ["code","name","currency","min_amount","max_amount","pay_frequency","status"];
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(","));
  return lines.join("\n");
}

async function importBands({ orgId, actorUserId, bands, mode = "upsert", audit, writeAudit }) {
  if (!Array.isArray(bands) || !bands.length) throw new AppError(400, "bands must be a non-empty array");
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let idx = 0; idx < bands.length; idx += 1) {
    const row0 = bands[idx] || {};
    try {
      if (!row0.code || !row0.name) { results.skipped += 1; continue; }
      const row = {
        ...row0,
        min_amount: coerceNumber(row0.min_amount),
        max_amount: coerceNumber(row0.max_amount),
      };
      const existing = await repo.getBandByCode(orgId, row.code);
      if (!existing) {
        if (mode === "update") { results.skipped += 1; continue; }
        await createBand({ orgId, actorUserId, payload: row, audit, writeAudit });
        results.created += 1;
      } else {
        if (mode === "create") { results.skipped += 1; continue; }
        await updateBand({ orgId, actorUserId, bandId: existing.id, payload: row, audit, writeAudit });
        results.updated += 1;
      }
    } catch (e) {
      results.errors.push({ index: idx, code: row0.code || null, message: e.message || String(e) });
    }
  }
  return results;
}

async function importBandsCsv({ orgId, actorUserId, csvText, mode = "upsert", audit, writeAudit }) {
  const rows = parseCsv(csvText);
  return importBands({ orgId, actorUserId, bands: rows, mode, audit, writeAudit });
}

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

module.exports = {
  createBand,
  listBands,
  getBand,
  updateBand,
  deactivateBand,
  exportBandsCsv,
  importBands,
  importBandsCsv,
};
