const { pool } = require('../../../db/pool');
function db(client) { return client || pool; }
async function listRules(orgId) { const { rows } = await pool.query(`SELECT * FROM automation_notification_rules WHERE organization_id=$1 ORDER BY created_at DESC`, [orgId]); return rows; }
async function getRule(orgId, id, client = null) { const { rows } = await db(client).query(`SELECT * FROM automation_notification_rules WHERE organization_id=$1 AND id=$2 LIMIT 1`, [orgId, id]); return rows[0] || null; }
async function createRule(orgId, userId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO automation_notification_rules(organization_id, code, name, trigger_type, target_user_id, severity, config_json, is_enabled, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
    [orgId, payload.code, payload.name, payload.triggerType, payload.targetUserId || null, payload.severity || 'info', JSON.stringify(payload.config || null), payload.isEnabled !== false, userId || null]
  );
  return rows[0];
}
async function updateRule(orgId, id, payload, client = null) {
  const { rows } = await db(client).query(
    `UPDATE automation_notification_rules SET name=COALESCE($3,name), trigger_type=COALESCE($4,trigger_type), target_user_id=COALESCE($5,target_user_id), severity=COALESCE($6,severity), config_json=COALESCE($7::jsonb,config_json), is_enabled=COALESCE($8,is_enabled), updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id, payload.name ?? null, payload.triggerType ?? null, payload.targetUserId ?? null, payload.severity ?? null, payload.config === undefined ? null : JSON.stringify(payload.config), typeof payload.isEnabled === 'boolean' ? payload.isEnabled : null]
  );
  return rows[0] || null;
}
module.exports = { listRules, getRule, createRule, updateRule };
