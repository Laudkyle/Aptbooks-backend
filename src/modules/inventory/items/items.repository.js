const { pool } = require("../../../db/pool"); 

async function createItem(orgId, payload) {
  const { categoryId, unitId, sku, name, isActive, barcode, reorderPoint, reorderQty } = payload; 
  const { rows } = await pool.query(
    `INSERT INTO inventory_items(organization_id, category_id, unit_id, sku, name, is_active, status, barcode, reorder_point, reorder_qty)
     VALUES($1,$2,$3,$4,$5,$6, CASE WHEN $6 THEN 'active' ELSE 'inactive' END, $7,$8,$9)
     RETURNING *`,
    [orgId, categoryId, unitId, sku, name, isActive !== false, barcode || null, reorderPoint ?? null, reorderQty ?? null]
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

async function updateItem(orgId, itemId, payload) {
  const isActive = payload.isActive; 
  const status = isActive === undefined ? null : (isActive ? 'active' : 'inactive'); 
  const { rows } = await pool.query(
    `UPDATE inventory_items
     SET category_id=COALESCE($3, category_id),
         unit_id=COALESCE($4, unit_id),
         sku=COALESCE($5, sku),
         name=COALESCE($6, name),
         is_active=COALESCE($7, is_active),
         status=COALESCE($8, status),
         barcode=COALESCE($9, barcode),
         reorder_point=COALESCE($10, reorder_point),
         reorder_qty=COALESCE($11, reorder_qty),
         updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [orgId, itemId,
      payload.categoryId ?? null,
      payload.unitId ?? null,
      payload.sku ?? null,
      payload.name ?? null,
      isActive === undefined ? null : !!isActive,
      status,
      payload.barcode ?? null,
      payload.reorderPoint ?? null,
      payload.reorderQty ?? null,
    ]
  ); 
  return rows[0] || null; 
}

async function deleteItem(orgId, itemId) {
  const { rows } = await pool.query(
    `UPDATE inventory_items SET is_active=false, status='inactive', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING id`,
    [orgId, itemId]
  ); 
  return rows[0] || null; 
}

module.exports = { createItem, listItems, getItem, updateItem, deleteItem }; 
