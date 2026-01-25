const { AppError } = require("../../../shared/errors/AppError"); 
const repo = require("./matching.repository"); 

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim(); 

}

function jaccard(a, b) {
  const A = new Set(normalize(a).split(" ").filter(Boolean)); 
  const B = new Set(normalize(b).split(" ").filter(Boolean)); 
  if (A.size === 0 || B.size === 0) return 0; 
  let inter = 0; 
  for (const w of A) if (B.has(w)) inter += 1; 
  const union = A.size + B.size - inter; 
  return union <= 0 ? 0 : inter / union; 
}

async function listRules(orgId) {
  return { data: await repo.listRules(orgId) }; 
}

async function createRule(orgId, userId, payload) {
  if (!payload?.name) throw new AppError(400, "name is required"); 
  const created = await repo.createRule(orgId, userId, payload); 
  return { data: created }; 
}

async function updateRule(orgId, ruleId, payload) {
  const updated = await repo.updateRule(orgId, ruleId, payload || {}); 
  if (!updated) throw new AppError(404, "Rule not found"); 
  return { data: updated }; 
}

async function suggestMatches(orgId, lineId, query = {}) {
  const line = await repo.getStatementLine(orgId, lineId); 
  if (!line) throw new AppError(404, "Statement line not found"); 

  if (line.matched) {
    return { data: [], note: "Line is already matched" }; 
  }

  const bankAccount = await repo.getBankAccount(orgId, line.bank_account_id); 
  if (!bankAccount) throw new AppError(404, "Bank account not found"); 

  const rules = (await repo.listRules(orgId)).filter((r) => r.is_active); 
  const effectiveRules = rules.length
    ? rules
    : [{
        id: null,
        name: "default",
        amount_tolerance: 0,
        date_window_days: 3,
        description_similarity_min: 0.3,
        priority: 100
      }]; 

  const max = Math.min(Number(query.limit || 10), 50); 

  const scored = []; 
  for (const r of effectiveRules) {
    const candidates = await repo.findCandidateJournalLines({
      orgId,
      bankGlAccountId: bankAccount.gl_account_id,
      txnDate: line.txn_date,
      amount: line.amount,
      dateWindowDays: r.date_window_days,
      amountTolerance: r.amount_tolerance,
      limit: 25
    }); 

    for (const c of candidates) {
      const sim = jaccard(line.description || "", `${c.memo || ""} ${c.line_description || ""}`); 
      if (sim < Number(r.description_similarity_min || 0)) continue; 
      const amountDiff = Math.abs(Number(c.signed_amount) - Number(line.amount)); 
      const score = (1 - Math.min(amountDiff / (Number(r.amount_tolerance || 1) || 1), 1)) * 0.55
        + sim * 0.35
        + (1 / (1 + Math.abs(new Date(c.entry_date).getTime() - new Date(line.txn_date).getTime()) / 86400000)) * 0.10; 

      scored.push({
        rule_id: r.id,
        rule_name: r.name,
        journal_entry_id: c.journal_entry_id,
        entry_date: c.entry_date,
        memo: c.memo,
        journal_entry_line_id: c.journal_entry_line_id,
        line_description: c.line_description,
        signed_amount: c.signed_amount,
        description_similarity: sim,
        amount_diff: amountDiff,
        score
      }); 
    }
  }

  // De-duplicate by journal entry id keeping best score
  const best = new Map(); 
  for (const s of scored) {
    const k = s.journal_entry_id; 
    const prev = best.get(k); 
    if (!prev || prev.score < s.score) best.set(k, s); 
  }

  const out = Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, max); 

  return { data: out }; 
}

module.exports = {
  listRules,
  createRule,
  updateRule,
  suggestMatches
}; 
