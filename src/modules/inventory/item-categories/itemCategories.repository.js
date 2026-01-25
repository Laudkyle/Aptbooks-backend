const { pool } = require("../../../db/pool");

async function createCategory(orgId, payload) {
  const { code, name, inventoryAccountId, cogsAccountId, adjustmentAccountId, clearingAccountId, parentId } = payload;
  const { rows } = await pool.query(
    `INSERT INTO item_categories(
        organization_id, code, name, inventory_account_id, cogs_account_id, adjustment_account_id, clearing_account_id, parent_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [orgId, code, name, inventoryAccountId, cogsAccountId, adjustmentAccountId, clearingAccountId, parentId || null]
  );
  return rows[0];
}

async function listCategories(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM item_categories WHERE organization_id=$1 ORDER BY code`,
    [orgId]
  );
  return rows;
}

async function getCategory(orgId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM item_categories WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  );
  return rows[0] || null;
}

async function updateCategory(orgId, id, payload) {
  const { rows } = await pool.query(
    `UPDATE item_categories
     SET code=COALESCE($3, code),
         name=COALESCE($4, name),
         inventory_account_id=COALESCE($5, inventory_account_id),
         cogs_account_id=COALESCE($6, cogs_account_id),
         adjustment_account_id=COALESCE($7, adjustment_account_id),
         clearing_account_id=COALESCE($8, clearing_account_id),
         parent_id=COALESCE($9, parent_id),
         updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [orgId, id,
      payload.code ?? null,
      payload.name ?? null,
      payload.inventoryAccountId ?? null,
      payload.cogsAccountId ?? null,
      payload.adjustmentAccountId ?? null,
      payload.clearingAccountId ?? null,
      payload.parentId ?? null,
    ]
  );
  return rows[0] || null;
}

async function deleteCategory(orgId, id) {
  const { rows } = await pool.query(
    `DELETE FROM item_categories WHERE organization_id=$1 AND id=$2 RETURNING id`,
    [orgId, id]
  );
  return rows[0] || null;
}

module.exports = { createCategory, listCategories, getCategory, updateCategory, deleteCategory };
