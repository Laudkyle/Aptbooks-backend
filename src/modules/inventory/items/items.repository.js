const { pool } = require("../../../db/pool");

async function createItem(orgId, payload) {
  const { categoryId, unitId, sku, name, isActive } = payload;
  const { rows } = await pool.query(
    `INSERT INTO inventory_items(organization_id, category_id, unit_id, sku, name, is_active)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [orgId, categoryId, unitId, sku, name, isActive !== false]
  );
  return rows[0];
}

async function listItems(orgId) {
  const { rows } = await pool.query(
    `SELECT i.*, c.code AS category_code, u.code AS unit_code
     FROM inventory_items i
     JOIN item_categories c ON c.id=i.category_id
     JOIN item_units u ON u.id=i.unit_id
     WHERE i.organization_id=$1
     ORDER BY i.sku`,
    [orgId]
  );
  return rows;
}

async function getItem(orgId, itemId) {
  const { rows } = await pool.query(
    `SELECT * FROM inventory_items WHERE organization_id=$1 AND id=$2`,
    [orgId, itemId]
  );
  return rows[0] || null;
}

module.exports = { createItem, listItems, getItem };
