const repo = require("./assetCategories.repository");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

async function assertPostableActiveAccount({ orgId, accountId, label }) {
  const { rows } = await pool.query(
    `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, `Invalid ${label}`);
  if (!rows[0].is_postable) throw new AppError(400, `${label} must be postable`);
  if (rows[0].status !== "active") throw new AppError(400, `${label} must be active`);
}

async function createCategory({ orgId, actorUserId, payload, audit = {} }) {
  await assertPostableActiveAccount({ orgId, accountId: payload.assetAccountId, label: "assetAccountId" });
  await assertPostableActiveAccount({ orgId, accountId: payload.accumDeprAccountId, label: "accumDeprAccountId" });
  await assertPostableActiveAccount({ orgId, accountId: payload.deprExpenseAccountId, label: "deprExpenseAccountId" });
  await assertPostableActiveAccount({ orgId, accountId: payload.disposalGainAccountId, label: "disposalGainAccountId" });
  await assertPostableActiveAccount({ orgId, accountId: payload.disposalLossAccountId, label: "disposalLossAccountId" });

  const created = await repo.createCategory({ orgId, payload });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "create",
    entityType: "asset_category",
    entityId: created.id,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before: null,
    after: created
  });
  return created;
}

async function listCategories({ orgId }) {
  return repo.listCategories({ orgId });
}

async function getCategory({ orgId, id }) {
  const cat = await repo.getCategory({ orgId, id });
  if (!cat) throw new AppError(404, "Asset category not found");
  return cat;
}

async function updateCategory({ orgId, actorUserId, id, payload, audit = {} }) {
  const before = await repo.getCategory({ orgId, id });
  if (!before) throw new AppError(404, "Asset category not found");

  if (payload.assetAccountId) await assertPostableActiveAccount({ orgId, accountId: payload.assetAccountId, label: "assetAccountId" });
  if (payload.accumDeprAccountId) await assertPostableActiveAccount({ orgId, accountId: payload.accumDeprAccountId, label: "accumDeprAccountId" });
  if (payload.deprExpenseAccountId) await assertPostableActiveAccount({ orgId, accountId: payload.deprExpenseAccountId, label: "deprExpenseAccountId" });
  if (payload.disposalGainAccountId) await assertPostableActiveAccount({ orgId, accountId: payload.disposalGainAccountId, label: "disposalGainAccountId" });
  if (payload.disposalLossAccountId) await assertPostableActiveAccount({ orgId, accountId: payload.disposalLossAccountId, label: "disposalLossAccountId" });

  if (payload.status && payload.status === "inactive") {
    const inUse = await repo.countAssetsInCategory({ orgId, categoryId: id });
    if (inUse > 0) throw new AppError(409, "Cannot deactivate category while assets exist in it");
  }

  const updated = await repo.updateCategory({ orgId, id, payload });
  if (!updated) throw new AppError(404, "Asset category not found");

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "update",
    entityType: "asset_category",
    entityId: id,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before,
    after: updated
  });
  return updated;
}

async function archiveCategory({ orgId, actorUserId, id, audit = {} }) {
  const before = await repo.getCategory({ orgId, id });
  if (!before) throw new AppError(404, "Asset category not found");
  const inUse = await repo.countAssetsInCategory({ orgId, categoryId: id });
  if (inUse > 0) throw new AppError(409, "Cannot archive category while assets exist in it");
  const after = await repo.updateCategory({ orgId, id, payload: { status: "inactive" } });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "archive",
    entityType: "asset_category",
    entityId: id,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before,
    after
  });
  return after;
}

module.exports = { createCategory, listCategories, getCategory, updateCategory, archiveCategory };
