const repo = require('./autoReconciliation.repository');
const matchingSvc = require('../../banking/matching/matching.service');
const { AppError } = require('../../../shared/errors/AppError');
const { withTransaction } = require('../../../db/tx');

async function listProfiles(orgId) { return { data: await repo.listProfiles(orgId) }; }
async function createProfile(orgId, userId, payload) {
  if (!payload?.name) throw new AppError(400, 'name is required');
  if (!payload?.bankAccountId) throw new AppError(400, 'bankAccountId is required');
  return { data: await repo.createProfile(orgId, userId, payload) };
}
async function updateProfile(orgId, id, payload) {
  const row = await repo.updateProfile(orgId, id, payload || {});
  if (!row) throw new AppError(404, 'Auto reconciliation profile not found');
  return { data: row };
}
async function getProfile(orgId, id) {
  const row = await repo.getProfile(orgId, id);
  if (!row) throw new AppError(404, 'Auto reconciliation profile not found');
  return { data: row };
}
async function runProfile(orgId, id) {
  return withTransaction(async (client) => {
    const profile = await repo.getProfile(orgId, id, client);
    if (!profile) throw new AppError(404, 'Auto reconciliation profile not found');
    const run = await repo.createRun(orgId, id, { runDate: new Date().toISOString().slice(0,10), status: 'running', message: 'Started' }, client);
    const candidates = await repo.listCandidateStatementLines(orgId, profile, client);
    let suggestionsStored = 0;
    for (const line of candidates) {
      const suggestions = await matchingSvc.suggestMatches(orgId, line.id, { limit: profile.max_suggestions_per_line || 3 });
      for (const item of (suggestions.data || [])) {
        const score = Number(item.score || 0);
        if (score < Number(profile.min_confidence_score || 0.75)) continue;
        await repo.addResult(orgId, run.id, {
          statementLineId: line.id,
          bankAccountId: profile.bank_account_id,
          confidenceScore: score,
          suggestionJson: item
        }, client);
        suggestionsStored += 1;
      }
    }
    const finished = await repo.finishRun(orgId, run.id, { status: 'completed', message: 'Completed', summaryJson: { candidateLines: candidates.length, suggestionsStored } }, client);
    return { data: finished };
  });
}
async function listRuns(orgId, profileId) {
  return { data: await repo.listRuns(orgId, profileId) };
}
async function listResults(orgId, runId) {
  return { data: await repo.listResults(orgId, runId) };
}
async function runEnabledProfiles({ orgId = null } = {}) {
  const profiles = orgId ? await repo.listProfiles(orgId) : [];
  let processed = 0;
  for (const p of profiles.filter((x) => x.is_enabled)) {
    try { await runProfile(p.organization_id, p.id); processed += 1; } catch (_) {}
  }
  return { message: `Processed ${processed} auto reconciliation profile(s)`, processed };
}
module.exports = { listProfiles, createProfile, updateProfile, getProfile, runProfile, listRuns, listResults, runEnabledProfiles };
