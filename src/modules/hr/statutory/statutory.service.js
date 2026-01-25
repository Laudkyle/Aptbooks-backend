const repo = require("./statutory.repository");
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

function coerceNumber(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function coerceDate(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

async function assertNoOverlapActiveRule(orgId, payload, excludeId = null) {
  const code = payload.code;
  const ruleType = payload.rule_type;
  const effectiveFrom = coerceDate(payload.effective_from) || new Date();
  const effectiveTo = coerceDate(payload.effective_to);
  const overlapping = await repo.findOverlappingActiveRules(orgId, {
    code,
    ruleType,
    effectiveFrom,
    effectiveTo: effectiveTo || null,
    excludeId,
  });
  if (overlapping) {
    throw new AppError(409, "OVERLAP", `Overlapping active statutory rule exists for ${code} (${ruleType}). Adjust effective dates or deactivate the other rule.`);
  }
}

async function createRule({ orgId, actorUserId, payload, audit, writeAudit }) {
  const p = { ...payload };
  if (p.brackets) {
    p.brackets_json = p.brackets;
    delete p.brackets;
  }
  // Effective-dated validation: prevent overlapping active rules for same code+type
  if ((p.status || "active") === "active") {
    await assertNoOverlapActiveRule(orgId, p);
  }
  // Normalize numeric fields
  p.employee_rate = coerceNumber(p.employee_rate) ?? p.employee_rate;
  p.employer_rate = coerceNumber(p.employer_rate) ?? p.employer_rate;
  p.allowance_amount = coerceNumber(p.allowance_amount) ?? p.allowance_amount;
  p.cap_amount = coerceNumber(p.cap_amount) ?? p.cap_amount;
  const created = await repo.createRule(orgId, p);
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.statutory_rule.created",
      entityType: "hr_statutory_rules",
      entityId: created.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return created;
}

async function listRules({ orgId, query }) {
  return repo.listRules(orgId, query);
}

async function exportStatutoryRulesCsv({ orgId, query }) {
  const rows = await repo.listRules(orgId, query || {});
  const headers = [
    "code","name","description","rule_type","calculation_method","base_on","allowance_amount","employee_rate","employer_rate","cap_amount",
    "expense_account_id","liability_account_id","effective_from","effective_to","status"
  ];
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(","));
  return lines.join("\n");
}

async function importStatutoryRules({ orgId, actorUserId, rules, mode = "upsert", audit, writeAudit }) {
  if (!Array.isArray(rules) || !rules.length) throw new AppError(400, "rules must be a non-empty array");
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let idx = 0;idx < rules.length;idx += 1) {
    const row0 = rules[idx] || {};
    try {
      if (!row0.code || !row0.name || !row0.rule_type) { results.skipped += 1;continue;}
      const existing = await repo.getRuleByCode(orgId, row0.code);
      if (!existing) {
        if (mode === "update") { results.skipped += 1;continue;}
        await createRule({ orgId, actorUserId, payload: row0, audit, writeAudit });
        results.created += 1;
      } else {
        if (mode === "create") { results.skipped += 1;continue;}
        await updateRule({ orgId, actorUserId, ruleId: existing.id, payload: row0, audit, writeAudit });
        results.updated += 1;
      }
    } catch (e) {
      results.errors.push({ index: idx, code: row0.code || null, message: e.message || String(e) });
    }
  }
  return results;
}

async function importStatutoryRulesCsv({ orgId, actorUserId, csvText, mode = "upsert", audit, writeAudit }) {
  const rows = parseCsv(csvText);
  // Coerce numeric fields
  const rules = rows.map(r => ({
    ...r,
    allowance_amount: coerceNumber(r.allowance_amount),
    employee_rate: coerceNumber(r.employee_rate),
    employer_rate: coerceNumber(r.employer_rate),
    cap_amount: coerceNumber(r.cap_amount),
  }));
  return importStatutoryRules({ orgId, actorUserId, rules, mode, audit, writeAudit });
}

async function assertNoOverlap({ orgId, code, rule_type, effective_from, effective_to, excludeId = null }) {
  if (!code || !rule_type) return;
  const ef = effective_from ? new Date(effective_from) : new Date();
  const et = effective_to ? new Date(effective_to) : null;
  const overlap = await repo.findOverlappingActiveRules(orgId, {
    code,
    ruleType: rule_type,
    effectiveFrom: ef,
    effectiveTo: et,
    excludeId,
  });
  if (overlap) {
    throw new AppError(409, "OVERLAP", `Active statutory rule overlap for code ${code} (${rule_type}) within effective date range`);
  }
}

async function exportRulesCsv({ orgId, query }) {
  const rows = await repo.listRules(orgId, query || {});
  const headers = [
    "code","name","description","rule_type","calculation_method","base_on","cap_amount",
    "allowance_amount","employee_rate","employer_rate","expense_account_id","liability_account_id",
    "effective_from","effective_to","status"
  ];
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(","));
  return lines.join("\n");
}

async function importRules({ orgId, actorUserId, rules, mode = "upsert", audit, writeAudit }) {
  if (!Array.isArray(rules) || !rules.length) throw new AppError(400, "rules must be a non-empty array");
  const results = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let idx = 0;idx < rules.length;idx += 1) {
    const row0 = rules[idx] || {};
    try {
      if (!row0.code || !row0.name || !row0.rule_type) { results.skipped += 1;continue;}
      const row = {
        ...row0,
        employee_rate: coerceNumber(row0.employee_rate),
        employer_rate: coerceNumber(row0.employer_rate),
        allowance_amount: coerceNumber(row0.allowance_amount),
        cap_amount: coerceNumber(row0.cap_amount),
        effective_from: coerceDate(row0.effective_from) || undefined,
        effective_to: coerceDate(row0.effective_to) || null,
      };
      const existing = await repo.getRuleByCode(orgId, row.code);
      if (!existing) {
        if (mode === "update") { results.skipped += 1;continue;}
        await createRule({ orgId, actorUserId, payload: row, audit, writeAudit });
        results.created += 1;
      } else {
        if (mode === "create") { results.skipped += 1;continue;}
        // If the update keeps/sets active status, enforce non-overlap
        const status = row.status ?? existing.status;
        const effFrom = row.effective_from ?? existing.effective_from;
        const effTo = row.effective_to !== undefined ? row.effective_to : existing.effective_to;
        if (status === "active") {
          await assertNoOverlapActiveRule(orgId, { ...existing, ...row, effective_from: effFrom, effective_to: effTo }, existing.id);
        }
        await updateRule({ orgId, actorUserId, ruleId: existing.id, payload: row, audit, writeAudit });
        results.updated += 1;
      }
    } catch (e) {
      results.errors.push({ index: idx, code: row0.code || null, message: e.message || String(e) });
    }
  }
  return results;
}

async function importRulesCsv({ orgId, actorUserId, csvText, mode = "upsert", audit, writeAudit }) {
  const rows = parseCsv(csvText);
  return importRules({ orgId, actorUserId, rules: rows, mode, audit, writeAudit });
}

async function updateRule({ orgId, actorUserId, ruleId, payload, audit, writeAudit }) {
  const p = { ...payload };
  if (p.brackets) {
    p.brackets_json = p.brackets;
    delete p.brackets;
  }
  const existing = await repo.getRule(orgId, ruleId);
  if (!existing) throw new AppError(404, "NOT_FOUND", "Statutory rule not found");
  const status = p.status ?? existing.status;
  const effFrom = p.effective_from ?? existing.effective_from;
  const effTo = (p.effective_to !== undefined) ? p.effective_to : existing.effective_to;
  if (status === "active") {
    await assertNoOverlapActiveRule(orgId, { ...existing, ...p, effective_from: effFrom, effective_to: effTo }, ruleId);
  }
  p.employee_rate = coerceNumber(p.employee_rate) ?? p.employee_rate;
  p.employer_rate = coerceNumber(p.employer_rate) ?? p.employer_rate;
  p.allowance_amount = coerceNumber(p.allowance_amount) ?? p.allowance_amount;
  p.cap_amount = coerceNumber(p.cap_amount) ?? p.cap_amount;
  const updated = await repo.updateRule(orgId, ruleId, p);
  if (!updated) throw new AppError(404, "NOT_FOUND", "Statutory rule not found");
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.statutory_rule.updated",
      entityType: "hr_statutory_rules",
      entityId: updated.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
      meta: payload,
    });
  }
  return updated;
}

async function deactivateRule({ orgId, actorUserId, ruleId, audit, writeAudit }) {
  const updated = await repo.deactivateRule(orgId, ruleId);
  if (!updated) throw new AppError(404, "NOT_FOUND", "Statutory rule not found");
  if (writeAudit) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "hr.statutory_rule.deactivated",
      entityType: "hr_statutory_rules",
      entityId: updated.id,
      ip: audit?.ip,
      userAgent: audit?.userAgent,
    });
  }
  return updated;
}

module.exports = {
  createRule,
  listRules,
  updateRule,
  deactivateRule,
  exportStatutoryRulesCsv,
  importRules,
  importRulesCsv,
};
