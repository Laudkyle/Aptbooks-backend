const { pool } = require("../../../db/pool");
function db(client = null) { return client || pool; }

async function createCategory(orgId, payload, client = null) {
  const { code, name, inventoryAccountId, cogsAccountId, adjustmentAccountId, clearingAccountId, parentId } = payload;
  const { rows } = await db(client).query(
    `INSERT INTO item_categories(
        organization_id, code, name, inventory_account_id, cogs_account_id, adjustment_account_id, clearing_account_id, parent_id,
        status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
     RETURNING *`,
    [orgId, code, name, inventoryAccountId, cogsAccountId, adjustmentAccountId, clearingAccountId, parentId || null]
  );
  return rows[0];
}

async function listCategories(orgId, client = null) {
  const { rows } = await db(client).query(`SELECT * FROM item_categories WHERE organization_id=$1 ORDER BY code`, [orgId]);
  return rows;
}
async function getCategory(orgId, id, client = null) {
  const { rows } = await db(client).query(`SELECT * FROM item_categories WHERE organization_id=$1 AND id=$2`, [orgId, id]);
  return rows[0] || null;
}
async function updateCategory(orgId, id, payload, client = null) {
  const { rows } = await db(client).query(
    `UPDATE item_categories
     SET code=COALESCE($3, code), name=COALESCE($4, name), inventory_account_id=COALESCE($5, inventory_account_id),
         cogs_account_id=COALESCE($6, cogs_account_id), adjustment_account_id=COALESCE($7, adjustment_account_id),
         clearing_account_id=COALESCE($8, clearing_account_id),
         parent_id=CASE WHEN $9::boolean THEN $10::uuid ELSE parent_id END,
         status=COALESCE($11,status), updated_at=NOW()
     WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id, payload.code ?? null, payload.name ?? null, payload.inventoryAccountId ?? null, payload.cogsAccountId ?? null,
      payload.adjustmentAccountId ?? null, payload.clearingAccountId ?? null,
      Object.prototype.hasOwnProperty.call(payload, 'parentId'), payload.parentId ?? null, payload.status ?? null]
  );
  return rows[0] || null;
}
async function deleteCategory(orgId, id, client = null) {
  const { rows } = await db(client).query(`DELETE FROM item_categories WHERE organization_id=$1 AND id=$2 RETURNING id`, [orgId, id]);
  return rows[0] || null;
}
async function getAccounts(orgId, ids, client = null) {
  if (!ids.length) return [];
  const { rows } = await db(client).query(
    `SELECT id, status, is_postable FROM chart_of_accounts WHERE organization_id=$1 AND id=ANY($2::uuid[])`, [orgId, ids]);
  return rows;
}
async function getActiveParent(orgId, parentId, client = null) {
  const { rows } = await db(client).query(
    `SELECT id FROM item_categories WHERE organization_id=$1 AND id=$2 AND status='active'`, [orgId, parentId]);
  return rows[0] || null;
}
async function hasActiveItems(orgId, categoryId, client = null) {
  const { rows } = await db(client).query(
    `SELECT 1 FROM inventory_items WHERE organization_id=$1 AND category_id=$2 AND status='active' LIMIT 1`, [orgId, categoryId]);
  return rows.length > 0;
}
async function hasItems(orgId, categoryId, client = null) {
  const { rows } = await db(client).query(
    `SELECT 1 FROM inventory_items WHERE organization_id=$1 AND category_id=$2 LIMIT 1`, [orgId, categoryId]);
  return rows.length > 0;
}

module.exports = { createCategory, listCategories, getCategory, updateCategory, deleteCategory, getAccounts, getActiveParent, hasActiveItems, hasItems };
