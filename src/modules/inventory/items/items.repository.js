const { pool } = require("../../../db/pool");

function db(client) { return client || pool; }

async function createItem(orgId, payload, client = null) {
  const { categoryId, unitId, sku, name, isActive, barcode, reorderPoint, reorderQty, taxProfileId, trackingMethod, preferredWarehouseId } = payload;
  const { rows } = await db(client).query(
    `INSERT INTO inventory_items(
       organization_id, category_id, unit_id, sku, name, is_active, status, barcode,
       reorder_point, reorder_quantity, tax_profile_id, tracking_method, preferred_warehouse_id, updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6 THEN 'active' ELSE 'inactive' END,$7,$8,$9,$10,$11,$12,NOW())
     RETURNING id, organization_id, category_id, unit_id, sku, name, is_active, status, barcode,
               reorder_point, reorder_quantity, tax_profile_id, tracking_method, preferred_warehouse_id, created_at, updated_at`,
    [orgId, categoryId, unitId, sku, name, isActive !== false, barcode || null, reorderPoint ?? 0,
      reorderQty ?? 0, taxProfileId || null, trackingMethod || 'none', preferredWarehouseId || null]
  );
  return rows[0];
}

async function listItems(orgId, { activeOnly = false } = {}, client = null) {
  const { rows } = await db(client).query(
    `SELECT i.id, i.organization_id, i.category_id, i.unit_id, i.sku, i.name, i.is_active, i.status,
            i.barcode, i.reorder_point, i.reorder_quantity, i.tax_profile_id, i.tracking_method,
            i.preferred_warehouse_id, i.created_at, i.updated_at,
            c.code AS category_code, c.name AS category_name,
            u.code AS unit_code, u.name AS unit_name, u.symbol AS unit_symbol, u.decimal_places AS unit_decimal_places,
            w.code AS preferred_warehouse_code, w.name AS preferred_warehouse_name,
            tcp.code AS tax_profile_code, tcp.name AS tax_profile_name, tcp.supply_type AS tax_supply_type,
            tcp.tax_category, tcp.sales_tax_scope, tcp.purchase_tax_scope,
            tcp.sales_tax_code_id, tcp.purchase_tax_code_id,
            COALESCE(b.qty_on_hand, 0)::text AS qty_on_hand,
            COALESCE(b.inventory_value, 0)::text AS inventory_value
       FROM inventory_items i
       JOIN item_categories c ON c.id=i.category_id AND c.organization_id=i.organization_id
       JOIN item_units u ON u.id=i.unit_id AND u.organization_id=i.organization_id
       LEFT JOIN warehouses w ON w.id=i.preferred_warehouse_id AND w.organization_id=i.organization_id
       LEFT JOIN tax_catalog_profiles tcp ON tcp.id=i.tax_profile_id AND tcp.organization_id=i.organization_id
       LEFT JOIN LATERAL (
          SELECT SUM(ib.qty_on_hand) AS qty_on_hand,
                 SUM(ib.qty_on_hand * ib.avg_unit_cost) AS inventory_value
            FROM inventory_balances ib
           WHERE ib.organization_id=i.organization_id AND ib.item_id=i.id
       ) b ON TRUE
      WHERE i.organization_id=$1 AND ($2::boolean=false OR i.status='active')
      ORDER BY i.sku`,
    [orgId, !!activeOnly]
  );
  return rows;
}

async function getItem(orgId, itemId, client = null, { forUpdate = false } = {}) {
  const { rows } = await db(client).query(
    `SELECT i.id, i.organization_id, i.category_id, i.unit_id, i.sku, i.name, i.is_active, i.status,
            i.barcode, i.reorder_point, i.reorder_quantity, i.tax_profile_id, i.tracking_method,
            i.preferred_warehouse_id, i.created_at, i.updated_at,
            c.code AS category_code, c.name AS category_name,
            u.code AS unit_code, u.name AS unit_name, u.symbol AS unit_symbol, u.decimal_places AS unit_decimal_places,
            w.code AS preferred_warehouse_code, w.name AS preferred_warehouse_name,
            tcp.code AS tax_profile_code, tcp.name AS tax_profile_name, tcp.supply_type AS tax_supply_type,
            tcp.tax_category, tcp.sales_tax_scope, tcp.purchase_tax_scope,
            tcp.sales_tax_code_id, tcp.purchase_tax_code_id, tcp.exemption_reason_code, tcp.exemption_reason,
            tcp.hs_code, tcp.fiscal_classification_code
       FROM inventory_items i
       JOIN item_categories c ON c.id=i.category_id AND c.organization_id=i.organization_id
       JOIN item_units u ON u.id=i.unit_id AND u.organization_id=i.organization_id
       LEFT JOIN warehouses w ON w.id=i.preferred_warehouse_id AND w.organization_id=i.organization_id
       LEFT JOIN tax_catalog_profiles tcp ON tcp.id=i.tax_profile_id AND tcp.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.id=$2${forUpdate ? ' FOR UPDATE OF i' : ''}`,
    [orgId, itemId]
  );
  return rows[0] || null;
}

async function updateItem(orgId, itemId, payload, client = null) {
  const isActive = payload.isActive;
  const status = isActive === undefined ? null : (isActive ? 'active' : 'inactive');
  const { rows } = await db(client).query(
    `UPDATE inventory_items
        SET category_id=COALESCE($3, category_id),
            unit_id=COALESCE($4, unit_id),
            sku=COALESCE($5, sku),
            name=COALESCE($6, name),
            is_active=COALESCE($7, is_active),
            status=COALESCE($8, status),
            barcode=CASE WHEN $9::boolean THEN $10 ELSE barcode END,
            reorder_point=COALESCE($11, reorder_point),
            reorder_quantity=COALESCE($12, reorder_quantity),
            tax_profile_id=CASE WHEN $13::boolean THEN $14::uuid ELSE tax_profile_id END,
            tracking_method=COALESCE($15, tracking_method),
            preferred_warehouse_id=CASE WHEN $16::boolean THEN $17::uuid ELSE preferred_warehouse_id END,
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING id, organization_id, category_id, unit_id, sku, name, is_active, status, barcode,
                reorder_point, reorder_quantity, tax_profile_id, tracking_method, preferred_warehouse_id, created_at, updated_at`,
    [orgId, itemId,
      payload.categoryId ?? null, payload.unitId ?? null, payload.sku ?? null, payload.name ?? null,
      isActive === undefined ? null : !!isActive, status,
      Object.prototype.hasOwnProperty.call(payload, 'barcode'), payload.barcode ?? null,
      payload.reorderPoint ?? null, payload.reorderQty ?? null,
      Object.prototype.hasOwnProperty.call(payload, 'taxProfileId'), payload.taxProfileId ?? null,
      payload.trackingMethod ?? null,
      Object.prototype.hasOwnProperty.call(payload, 'preferredWarehouseId'), payload.preferredWarehouseId ?? null]
  );
  return rows[0] || null;
}

async function deactivateItem(orgId, itemId, client = null) {
  const { rows } = await db(client).query(
    `UPDATE inventory_items SET is_active=false, status='inactive', updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 RETURNING id`, [orgId, itemId]);
  return rows[0] || null;
}

async function getOnHand(orgId, itemId, client = null) {
  const { rows } = await db(client).query(
    `SELECT COALESCE(SUM(qty_on_hand),0)::text AS qty_on_hand
       FROM inventory_balances WHERE organization_id=$1 AND item_id=$2`, [orgId, itemId]);
  return rows[0]?.qty_on_hand || '0';
}

async function hasActiveReservations(orgId, itemId, client = null) {
  const { rows } = await db(client).query(
    `SELECT 1 FROM inventory_reservations
      WHERE organization_id=$1 AND item_id=$2 AND status='active' LIMIT 1`, [orgId, itemId]);
  return rows.length > 0;
}

module.exports = { createItem, listItems, getItem, updateItem, deactivateItem, getOnHand, hasActiveReservations };
