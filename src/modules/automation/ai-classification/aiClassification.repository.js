const { pool } = require('../../../db/pool');
function db(client) { return client || pool; }
async function listRules(orgId) { const { rows } = await pool.query(`SELECT * FROM automation_classification_rules WHERE organization_id=$1 ORDER BY priority ASC, created_at DESC`, [orgId]); return rows; }
async function createRule(orgId, userId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO automation_classification_rules(organization_id, name, target_kind, keyword_pattern, exclude_pattern, output_json, priority, is_active, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
    [orgId, payload.name, payload.targetKind || 'transaction', payload.keywordPattern || null, payload.excludePattern || null, JSON.stringify(payload.output || null), payload.priority ?? 100, payload.isActive !== false, userId || null]
  );
  return rows[0];
}
async function updateRule(orgId, id, payload, client = null) {
  const { rows } = await db(client).query(
    `UPDATE automation_classification_rules SET name=COALESCE($3,name), target_kind=COALESCE($4,target_kind), keyword_pattern=COALESCE($5,keyword_pattern), exclude_pattern=COALESCE($6,exclude_pattern), output_json=COALESCE($7::jsonb,output_json), priority=COALESCE($8,priority), is_active=COALESCE($9,is_active), updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id, payload.name ?? null, payload.targetKind ?? null, payload.keywordPattern ?? null, payload.excludePattern ?? null, payload.output === undefined ? null : JSON.stringify(payload.output), payload.priority ?? null, typeof payload.isActive === 'boolean' ? payload.isActive : null]
  );
  return rows[0] || null;
}
async function logClassification(orgId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO automation_classification_logs(organization_id, source_text, source_kind, matched_rule_id, output_json, confidence_score)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
    [orgId, payload.sourceText, payload.sourceKind || 'transaction', payload.matchedRuleId || null, JSON.stringify(payload.output || null), payload.confidenceScore ?? 0]
  );
  return rows[0];
}
async function listLogs(orgId, limit = 100) { const { rows } = await pool.query(`SELECT * FROM automation_classification_logs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2`, [orgId, Math.min(Number(limit||100),200)]); return rows; }
module.exports = { listRules, createRule, updateRule, logClassification, listLogs };
