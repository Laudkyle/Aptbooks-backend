const repo = require('./aiClassification.repository');
const { AppError } = require('../../../shared/errors/AppError');
function normalize(s) { return String(s || '').toLowerCase(); }
function tokens(s) { return normalize(s).split(/[^a-z0-9]+/).filter(Boolean); }
function keywordScore(text, pattern) {
  const parts = tokens(pattern);
  if (!parts.length) return 0;
  const hay = normalize(text);
  let hits = 0;
  for (const p of parts) if (hay.includes(p)) hits += 1;
  return hits / parts.length;
}
async function listRules(orgId) { return { data: await repo.listRules(orgId) }; }
async function createRule(orgId, userId, payload) { if (!payload?.name) throw new AppError(400, 'name is required'); return { data: await repo.createRule(orgId, userId, payload) }; }
async function updateRule(orgId, id, payload) { const row = await repo.updateRule(orgId, id, payload || {}); if (!row) throw new AppError(404, 'Classification rule not found'); return { data: row }; }
async function classify(orgId, payload) {
  const text = String(payload?.text || payload?.sourceText || '').trim();
  if (!text) throw new AppError(400, 'text is required');
  const sourceKind = payload?.sourceKind || 'transaction';
  const rules = (await repo.listRules(orgId)).filter((r) => r.is_active && (!r.target_kind || r.target_kind === sourceKind));
  let best = null;
  for (const r of rules) {
    if (r.exclude_pattern && keywordScore(text, r.exclude_pattern) > 0) continue;
    const score = keywordScore(text, r.keyword_pattern || '');
    if (score <= 0) continue;
    if (!best || score > best.score || (score === best.score && Number(r.priority || 100) < Number(best.rule.priority || 100))) {
      best = { rule: r, score };
    }
  }
  const output = best ? (best.rule.output_json || {}) : { classification: 'unclassified' };
  const log = await repo.logClassification(orgId, {
    sourceText: text,
    sourceKind,
    matchedRuleId: best?.rule?.id || null,
    output,
    confidenceScore: best?.score || 0
  });
  return { data: { classification: output, confidenceScore: best?.score || 0, matchedRule: best?.rule || null, log } };
}
async function listLogs(orgId, limit) { return { data: await repo.listLogs(orgId, limit) }; }
module.exports = { listRules, createRule, updateRule, classify, listLogs };
