const { pool } = require('../../../db/pool');
function db(client) { return client || pool; }

async function listProfiles(orgId) {
  const { rows } = await pool.query(`SELECT * FROM automation_reconciliation_profiles WHERE organization_id=$1 ORDER BY created_at DESC`, [orgId]);
  return rows;
}
async function getProfile(orgId, id, client = null) {
  const { rows } = await db(client).query(`SELECT * FROM automation_reconciliation_profiles WHERE organization_id=$1 AND id=$2 LIMIT 1`, [orgId, id]);
  return rows[0] || null;
}
async function createProfile(orgId, userId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO automation_reconciliation_profiles(
      organization_id, name, bank_account_id, min_confidence_score, lookback_days,
      max_suggestions_per_line, is_enabled, created_by_user_id, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
    [orgId, payload.name, payload.bankAccountId, payload.minConfidenceScore ?? 0.75, payload.lookbackDays ?? 30, payload.maxSuggestionsPerLine ?? 3, payload.isEnabled !== false, userId || null, JSON.stringify(payload.metadata || null)]
  );
  return rows[0];
}
async function updateProfile(orgId, id, payload, client = null) {
  const { rows } = await db(client).query(
    `UPDATE automation_reconciliation_profiles
     SET name=COALESCE($3,name), bank_account_id=COALESCE($4,bank_account_id),
         min_confidence_score=COALESCE($5,min_confidence_score), lookback_days=COALESCE($6,lookback_days),
         max_suggestions_per_line=COALESCE($7,max_suggestions_per_line), is_enabled=COALESCE($8,is_enabled),
         metadata=COALESCE($9::jsonb, metadata), updated_at=NOW()
     WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id, payload.name ?? null, payload.bankAccountId ?? null, payload.minConfidenceScore ?? null, payload.lookbackDays ?? null, payload.maxSuggestionsPerLine ?? null, typeof payload.isEnabled === 'boolean' ? payload.isEnabled : null, payload.metadata === undefined ? null : JSON.stringify(payload.metadata)]
  );
  return rows[0] || null;
}
async function createRun(orgId, profileId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO automation_reconciliation_runs(organization_id, profile_id, run_date, status, message, summary_json)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
    [orgId, profileId, payload.runDate, payload.status, payload.message || null, JSON.stringify(payload.summaryJson || null)]
  );
  return rows[0];
}
async function finishRun(orgId, runId, payload, client = null) {
  const { rows } = await db(client).query(
    `UPDATE automation_reconciliation_runs SET status=$3, message=$4, summary_json=$5::jsonb, completed_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, runId, payload.status, payload.message || null, JSON.stringify(payload.summaryJson || null)]
  );
  return rows[0];
}
async function addResult(orgId, runId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO automation_reconciliation_results(
      organization_id, run_id, statement_line_id, bank_account_id, confidence_score, suggestion_json
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
    [orgId, runId, payload.statementLineId, payload.bankAccountId, payload.confidenceScore, JSON.stringify(payload.suggestionJson || null)]
  );
  return rows[0];
}
async function listRuns(orgId, profileId) {
  const { rows } = await pool.query(`SELECT * FROM automation_reconciliation_runs WHERE organization_id=$1 AND profile_id=$2 ORDER BY created_at DESC`, [orgId, profileId]);
  return rows;
}
async function listResults(orgId, runId) {
  const { rows } = await pool.query(`SELECT * FROM automation_reconciliation_results WHERE organization_id=$1 AND run_id=$2 ORDER BY confidence_score DESC, created_at ASC`, [orgId, runId]);
  return rows;
}
async function listCandidateStatementLines(orgId, profile, client = null) {
  const { rows } = await db(client).query(
    `SELECT l.id, l.txn_date, l.description, l.amount, s.bank_account_id
     FROM bank_statement_lines l
     JOIN bank_statements s ON s.id = l.statement_id
     WHERE s.organization_id=$1
       AND s.bank_account_id=$2
       AND COALESCE(l.matched, FALSE)=FALSE
       AND l.txn_date >= (CURRENT_DATE - ($3::int))
     ORDER BY l.txn_date DESC, l.id DESC`,
    [orgId, profile.bank_account_id, profile.lookback_days || 30]
  );
  return rows;
}
module.exports = { listProfiles, getProfile, createProfile, updateProfile, createRun, finishRun, addResult, listRuns, listResults, listCandidateStatementLines };
