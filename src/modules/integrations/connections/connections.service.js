const { AppError } = require("../../../shared/errors/AppError");
const repo = require("./connections.repository");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

function assertStatus(s) {
  if (s && !['disabled','enabled','error'].includes(s)) throw new AppError(400, 'Invalid status');
}

async function list(ctx) {
  return repo.listConnections({ organizationId: ctx.organizationId });
}

async function create(ctx, payload) {
  if (!payload.type) throw new AppError(400, 'type required');
  if (!payload.name) throw new AppError(400, 'name required');
  assertStatus(payload.status);
  const created = await repo.createConnection({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    type: String(payload.type),
    name: String(payload.name),
    status: payload.status || 'disabled',
    configJson: payload.configJson || {},
  });
  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'integrations.connection.create',
    entityType: 'integration_connection',
    entityId: created.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before: null,
    after: created,
  });
  return created;
}

async function update(ctx, id, patch) {
  const before = await repo.getConnection({ organizationId: ctx.organizationId, connectionId: id });
  if (!before) throw new AppError(404, 'Connection not found');
  if (patch.status) assertStatus(patch.status);
  const after = await repo.updateConnection({ organizationId: ctx.organizationId, connectionId: id, patch: {
    type: patch.type,
    name: patch.name,
    status: patch.status,
    configJson: patch.configJson,
  }});
  if (!after) throw new AppError(404, 'Connection not found');
  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'integrations.connection.update',
    entityType: 'integration_connection',
    entityId: id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before,
    after,
  });
  return after;
}

async function test(ctx, id) {
  const before = await repo.getConnection({ organizationId: ctx.organizationId, connectionId: id });
  if (!before) throw new AppError(404, 'Connection not found');
  // Generic test: validate JSON and required keys per type (minimal scaffolding).
  const cfg = before.config_json || {};
  let ok = true;
  let msg = 'OK';
  if (before.type === 'odbc' || before.type === 'jdbc') {
    if (!cfg.connectionString) { ok = false; msg = 'configJson.connectionString required'; }
  }
  if (before.type === 'webhook') {
    if (!cfg.url) { ok = false; msg = 'configJson.url required'; }
  }
  const after = await repo.updateConnection({ organizationId: ctx.organizationId, connectionId: id, patch: {
    lastTestedAt: new Date().toISOString(),
    lastTestResult: ok ? 'success' : `failed: ${msg}`
  }});
  return { ok, message: msg, connection: after };
}

async function remove(ctx, id) {
  const before = await repo.getConnection({ organizationId: ctx.organizationId, connectionId: id });
  if (!before) throw new AppError(404, 'Connection not found');
  await repo.deleteConnection({ organizationId: ctx.organizationId, connectionId: id });
  await writeAudit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'integrations.connection.delete',
    entityType: 'integration_connection',
    entityId: id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before,
    after: null,
  });
  return { id };
}

module.exports = { list, create, update, test, remove };
