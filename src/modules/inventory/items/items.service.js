const repo = require("./items.repository");
const { AppError } = require("../../../shared/errors/AppError");
const { pool } = require("../../../db/pool");


async function assertTaxProfile(orgId, taxProfileId) {
  if (taxProfileId === undefined || taxProfileId === null || taxProfileId === '') return;
  const { rows } = await pool.query(
    `SELECT id FROM tax_catalog_profiles WHERE organization_id=$1 AND id=$2 AND status='active'`,
    [orgId, taxProfileId]
  );
  if (!rows.length) throw new AppError(400, 'Invalid or inactive taxProfileId');
}

async function createItem(orgId, payload) {
  const req = ["categoryId", "unitId", "sku", "name"];
  for (const k of req) if (!payload?.[k]) throw new AppError(400, `${k} is required`);
  await assertTaxProfile(orgId, payload?.taxProfileId);
  return repo.createItem(orgId, payload);
}

async function listItems(orgId) { return repo.listItems(orgId); }

async function getItem(orgId, id) {
  const item = await repo.getItem(orgId, id);
  if (!item) throw new AppError(404, "Item not found");
  return item;
}

async function updateItem(orgId, id, payload) {
  await assertTaxProfile(orgId, payload?.taxProfileId);
  const updated = await repo.updateItem(orgId, id, payload);
  if (!updated) throw new AppError(404, "Item not found");
  return updated;
}

async function deleteItem(orgId, id) {
  const out = await repo.deleteItem(orgId, id);
  if (!out) throw new AppError(404, "Item not found");
  return { deleted: true, id };
}

module.exports = { createItem, listItems, getItem, updateItem, deleteItem };
