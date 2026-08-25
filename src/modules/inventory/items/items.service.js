const repo = require("./items.repository");
const { AppError } = require("../../../shared/errors/AppError");
const { pool } = require("../../../db/pool");

async function assertTaxProfile(orgId, taxProfileId, client = null) {
  if (taxProfileId === undefined || taxProfileId === null || taxProfileId === '') return;
  const { rows } = await (client || pool).query(
    `SELECT id FROM tax_catalog_profiles WHERE organization_id=$1 AND id=$2 AND status='active'`, [orgId, taxProfileId]);
  if (!rows.length) throw new AppError(422, 'Invalid or inactive taxProfileId');
}

async function assertMasterReferences(orgId, payload, client = null) {
  const conn = client || pool;
  if (payload.categoryId) {
    const { rows } = await conn.query(`SELECT id FROM item_categories WHERE organization_id=$1 AND id=$2 AND status='active'`, [orgId, payload.categoryId]);
    if (!rows.length) throw new AppError(422, 'categoryId must reference an active inventory category');
  }
  if (payload.unitId) {
    const { rows } = await conn.query(`SELECT id FROM item_units WHERE organization_id=$1 AND id=$2 AND status='active'`, [orgId, payload.unitId]);
    if (!rows.length) throw new AppError(422, 'unitId must reference an active unit');
  }
  if (payload.preferredWarehouseId) {
    const { rows } = await conn.query(`SELECT id FROM warehouses WHERE organization_id=$1 AND id=$2 AND status='active' AND is_active=true`, [orgId, payload.preferredWarehouseId]);
    if (!rows.length) throw new AppError(422, 'preferredWarehouseId must reference an active warehouse');
  }
  await assertTaxProfile(orgId, payload.taxProfileId, conn);
}

async function createItem(orgId, payload) {
  await assertMasterReferences(orgId, payload);
  return repo.createItem(orgId, payload);
}
async function listItems(orgId, options) { return repo.listItems(orgId, options); }
async function getItem(orgId, id) {
  const item = await repo.getItem(orgId, id);
  if (!item) throw new AppError(404, "Item not found");
  return item;
}
async function updateItem(orgId, id, payload) {
  const current = await repo.getItem(orgId, id);
  if (!current) throw new AppError(404, 'Item not found');
  await assertMasterReferences(orgId, payload);
  if (payload.isActive === false) {
    if (Number(await repo.getOnHand(orgId, id)) !== 0) throw new AppError(409, 'An item with stock on hand cannot be deactivated');
    if (await repo.hasActiveReservations(orgId, id)) throw new AppError(409, 'Release active reservations before deactivating this item');
  }
  const updated = await repo.updateItem(orgId, id, payload);
  if (!updated) throw new AppError(404, "Item not found");
  return updated;
}
async function deleteItem(orgId, id) {
  await getItem(orgId, id);
  if (Number(await repo.getOnHand(orgId, id)) !== 0) throw new AppError(409, 'An item with stock on hand cannot be archived');
  if (await repo.hasActiveReservations(orgId, id)) throw new AppError(409, 'Release active reservations before archiving this item');
  const out = await repo.deactivateItem(orgId, id);
  return { archived: true, id: out.id };
}
module.exports = { createItem, listItems, getItem, updateItem, deleteItem };
