const { pool } = require("../../../db/pool");

async function writeAudit({
  organizationId,
  actorUserId,
  action,
  entityType,
  entityId,
  ip,
  userAgent,
  before,
  after
}) {
  await pool.query(
    `
    INSERT INTO audit_logs
      (organization_id, actor_user_id, action, entity_type, entity_id, ip, user_agent, before_json, after_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
    [
      organizationId,
      actorUserId || null,
      action,
      entityType || null,
      entityId || null,
      ip || null,
      userAgent || null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null
    ]
  );
}

module.exports = { writeAudit };
