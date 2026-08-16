const { pool } = require("../../../db/pool");

async function createItem(orgId, payload) {
  const { categoryId, unitId, sku, name, isActive, barcode, reorderPoint, reorderQty, taxProfileId } = payload;
  const { rows } = await pool.query(
    `INSERT INTO inventory_items(organization_id, category_id, unit_id, sku, name, is_active, status, barcode, reorder_point, reorder_quantity, tax_profile_id)
     VALUES($1,$2,$3,$4,$5,$6, CASE WHEN $6 THEN 'active' ELSE 'inactive' END, $7,$8,$9,$10)
     RETURNING *`,
    [orgId, categoryId, unitId, sku, name, isActive !== false, barcode || null, reorderPoint ?? 0, reorderQty ?? 0, taxProfileId || null]
  );
  return rows[0];
}

async function listItems(orgId) {
  const { rows } = await pool.query(
    `SELECT i.*, c.code AS category_code, u.code AS unit_code,
            tcp.code AS tax_profile_code, tcp.name AS tax_profile_name, tcp.supply_type AS tax_supply_type,
            tcp.tax_category, tcp.sales_tax_scope, tcp.purchase_tax_scope,
            tcp.sales_tax_code_id, tcp.purchase_tax_code_id
     FROM inventory_items i
     JOIN item_categories c ON c.id=i.category_id
     JOIN item_units u ON u.id=i.unit_id
     LEFT JOIN tax_catalog_profiles tcp ON tcp.id=i.tax_profile_id AND tcp.organization_id=i.organization_id
     WHERE i.organization_id=$1
     ORDER BY i.sku`,
    [orgId]
  );
  return rows;
}

async function getItem(orgId, itemId) {
  const { rows } = await pool.query(
    `SELECT i.*, tcp.code AS tax_profile_code, tcp.name AS tax_profile_name, tcp.supply_type AS tax_supply_type,
            tcp.tax_category, tcp.sales_tax_scope, tcp.purchase_tax_scope,
            tcp.sales_tax_code_id, tcp.purchase_tax_code_id, tcp.exemption_reason_code, tcp.exemption_reason,
            tcp.hs_code, tcp.fiscal_classification_code
       FROM inventory_items i
       LEFT JOIN tax_catalog_profiles tcp ON tcp.id=i.tax_profile_id AND tcp.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.id=$2`,
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
         reorder_quantity=COALESCE($11, reorder_quantity),
         tax_profile_id=CASE WHEN $12::boolean THEN $13::uuid ELSE tax_profile_id END
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
      Object.prototype.hasOwnProperty.call(payload, "taxProfileId"),
      payload.taxProfileId ?? null,
    ]
  );
  return rows[0] || null;
}

async function deleteItem(orgId, itemId) {
  const { rows } = await pool.query(
    `UPDATE inventory_items SET is_active=false, status='inactive' WHERE organization_id=$1 AND id=$2 RETURNING id`,
    [orgId, itemId]
  );
  return rows[0] || null;
}

module.exports = { createItem, listItems, getItem, updateItem, deleteItem };
