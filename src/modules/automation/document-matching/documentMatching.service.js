const repo = require('./documentMatching.repository');
const { AppError } = require('../../../shared/errors/AppError');
const { withTransaction } = require('../../../db/tx');

function scoreCandidate(c) {
  let score = 0.5;
  const amountDiff = Math.abs(Number(c.source_amount || 0) - Number(c.target_amount || 0));
  if (amountDiff === 0) score += 0.25;
  else score += Math.max(0, 0.25 - Math.min(amountDiff / Math.max(Number(c.source_amount || 1), 1), 0.25));
  const sd = new Date(`${c.source_date}T00:00:00Z`).getTime();
  const td = new Date(`${c.target_date}T00:00:00Z`).getTime();
  const dayDiff = Math.abs(sd - td) / 86400000;
  score += Math.max(0, 0.2 - Math.min(dayDiff * 0.03, 0.2));
  if ((c.customer_id && c.customer_id === c.target_customer_id) || (c.vendor_id && c.vendor_id === c.target_vendor_id)) score += 0.05;
  return Math.min(score, 0.99);
}

async function listProfiles(orgId) { return { data: await repo.listProfiles(orgId) }; }
async function createProfile(orgId, userId, payload) {
  if (!payload?.name) throw new AppError(400, 'name is required');
  if (!payload?.sourceType || !payload?.targetType) throw new AppError(400, 'sourceType and targetType are required');
  return { data: await repo.createProfile(orgId, userId, payload) };
}
async function updateProfile(orgId, id, payload) {
  const row = await repo.updateProfile(orgId, id, payload || {});
  if (!row) throw new AppError(404, 'Document matching profile not found');
  return { data: row };
}
async function getProfile(orgId, id) {
  const row = await repo.getProfile(orgId, id);
  if (!row) throw new AppError(404, 'Document matching profile not found');
  return { data: row };
}
async function runProfile(orgId, id) {
  return withTransaction(async (client) => {
    const profile = await repo.getProfile(orgId, id, client);
    if (!profile) throw new AppError(404, 'Document matching profile not found');
    const run = await repo.createRun(orgId, id, new Date().toISOString().slice(0, 10), client);
    const candidates = await repo.getCandidates(orgId, profile, client);
    let stored = 0;
    for (const c of candidates) {
      const confidence = scoreCandidate(c);
      if (confidence < Number(profile.min_confidence_score || 0.7)) continue;
      await repo.addResult(orgId, run.id, {
        sourceEntityType: profile.source_type,
        sourceEntityId: c.source_id,
        targetEntityType: profile.target_type,
        targetEntityId: c.target_id,
        confidenceScore: confidence,
        reason: `amount/date/entity similarity (${c.source_code} → ${c.target_code})`
      }, client);
      stored += 1;
    }
    const finished = await repo.finishRun(orgId, run.id, 'completed', { candidates: candidates.length, suggestionsStored: stored }, client);
    return { data: finished };
  });
}
async function listRuns(orgId, profileId) { return { data: await repo.listRuns(orgId, profileId) }; }
async function listResults(orgId, runId) { return { data: await repo.listResults(orgId, runId) }; }
module.exports = { listProfiles, createProfile, updateProfile, getProfile, runProfile, listRuns, listResults };
