const { pool, setClientTenant } = require('../../../db/pool');
const { runWithTenant } = require('../../../shared/security/tenantContext');

async function insertAudit(db, {
  organizationId,
  actorUserId,
  action,
  entityType,
  entityId,
  ip,
  userAgent,
  before,
  after,
}) {
  await db.query(
    `INSERT INTO audit_logs
      (organization_id, actor_user_id, action, entity_type, entity_id, ip, user_agent, before_json, after_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      organizationId,
      actorUserId || null,
      action,
      entityType || null,
      entityId || null,
      ip || null,
      userAgent || null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    ]
  );
}

async function writeAudit(payload) {
  const organizationId = payload?.organizationId;
  if (!organizationId) throw new Error('Audit events require organizationId');

  if (payload.client) {
    // Covers bootstrap and organization-switch transactions where the active
    // request tenant may not yet match the audit tenant.
    await setClientTenant(payload.client, organizationId, { local: false });
    return insertAudit(payload.client, payload);
  }

  return runWithTenant(organizationId, () => insertAudit(pool, payload));
}

module.exports = { writeAudit };
