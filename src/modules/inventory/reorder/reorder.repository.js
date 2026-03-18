const { pool } = require('../../../db/pool');

async function listSettings(orgId, { warehouseId, itemId } = {}, client = null) {
  const db = client || pool;
  const params = [orgId];
  const where = ['s.organization_id=$1'];
  if (warehouseId) { params.push(warehouseId); where.push(`s.warehouse_id=$${params.length}`); }
  if (itemId) { params.push(itemId); where.push(`s.item_id=$${params.length}`); }
  const { rows } = await db.query(
    `SELECT s.*, w.code AS warehouse_code, i.sku, i.name AS item_name
       FROM inventory_reorder_settings s
       JOIN warehouses w ON w.id=s.warehouse_id
       JOIN inventory_items i ON i.id=s.item_id
      WHERE ${where.join(' AND ')}
      ORDER BY w.code, i.sku`,
    params
  );
  return rows;
}

async function upsertSetting(client, orgId, payload) {
  const { rows } = await client.query(
    `INSERT INTO inventory_reorder_settings(
        organization_id, warehouse_id, item_id, reorder_point, reorder_quantity, safety_stock, lead_time_days, updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (organization_id, warehouse_id, item_id)
     DO UPDATE SET reorder_point=EXCLUDED.reorder_point,
                   reorder_quantity=EXCLUDED.reorder_quantity,
                   safety_stock=EXCLUDED.safety_stock,
                   lead_time_days=EXCLUDED.lead_time_days,
                   updated_at=NOW()
     RETURNING *`,
    [orgId, payload.warehouseId, payload.itemId, payload.reorderPoint, payload.reorderQuantity, payload.safetyStock, payload.leadTimeDays]
  );
  return rows[0];
}

async function computeSuggestions(orgId, { warehouseId, itemId } = {}, client = null) {
  const db = client || pool;
  const params = [orgId];
  const where = ['s.organization_id=$1'];
  if (warehouseId) { params.push(warehouseId); where.push(`s.warehouse_id=$${params.length}`); }
  if (itemId) { params.push(itemId); where.push(`s.item_id=$${params.length}`); }
  const { rows } = await db.query(
    `SELECT s.organization_id, s.warehouse_id, w.code AS warehouse_code, s.item_id, i.sku, i.name AS item_name,
            s.reorder_point, s.reorder_quantity, s.safety_stock, s.lead_time_days,
            COALESCE(b.qty_on_hand,0) AS qty_on_hand,
            COALESCE(r.qty_reserved,0) AS qty_reserved,
            (COALESCE(b.qty_on_hand,0) - COALESCE(r.qty_reserved,0)) AS qty_available,
            CASE
              WHEN (COALESCE(b.qty_on_hand,0) - COALESCE(r.qty_reserved,0)) <= s.reorder_point
              THEN GREATEST(s.reorder_quantity, (s.safety_stock + s.reorder_point) - (COALESCE(b.qty_on_hand,0) - COALESCE(r.qty_reserved,0)))
              ELSE 0
            END AS recommended_qty
       FROM inventory_reorder_settings s
       JOIN warehouses w ON w.id=s.warehouse_id
       JOIN inventory_items i ON i.id=s.item_id
       LEFT JOIN inventory_balances b ON b.organization_id=s.organization_id AND b.warehouse_id=s.warehouse_id AND b.item_id=s.item_id
       LEFT JOIN (
         SELECT organization_id, warehouse_id, item_id, SUM(qty_reserved) AS qty_reserved
         FROM inventory_reservations
         WHERE status='active'
         GROUP BY organization_id, warehouse_id, item_id
       ) r ON r.organization_id=s.organization_id AND r.warehouse_id=s.warehouse_id AND r.item_id=s.item_id
      WHERE ${where.join(' AND ')}
      ORDER BY recommended_qty DESC, w.code, i.sku`,
    params
  );
  return rows.filter((r) => Number(r.recommended_qty) > 0);
}

module.exports = { listSettings, upsertSetting, computeSuggestions };
