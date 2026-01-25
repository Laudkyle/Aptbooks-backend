const { pool } = require("../../db/pool"); 

async function valuationCurrent({ orgId, warehouseId }) {
  const params = [orgId]; 
  let filter = ""; 
  if (warehouseId) {
    params.push(warehouseId); 
    filter = "AND ib.warehouse_id=$2"; 
  }

  const { rows } = await pool.query(
    `
    SELECT
      ib.warehouse_id,
      w.code AS warehouse_code,
      w.name AS warehouse_name,
      ib.item_id,
      ii.sku,
      ii.name AS item_name,
      ib.qty_on_hand,
      ib.avg_unit_cost,
      (ib.qty_on_hand * ib.avg_unit_cost) AS extended_value
    FROM inventory_balances ib
    JOIN warehouses w ON w.id = ib.warehouse_id
    JOIN inventory_items ii ON ii.id = ib.item_id
    WHERE ib.organization_id=$1
      ${filter}
    ORDER BY w.code, ii.sku
    `,
    params
  ); 

  const total_value = rows.reduce((s, r) => s + Number(r.extended_value || 0), 0); 
  return {
    warehouse_id: warehouseId || null,
    total_value,
    lines: rows.map((r) => ({
      warehouse: { id: r.warehouse_id, code: r.warehouse_code, name: r.warehouse_name },
      item: { id: r.item_id, sku: r.sku, name: r.item_name },
      qty_on_hand: Number(r.qty_on_hand || 0),
      avg_unit_cost: Number(r.avg_unit_cost || 0),
      extended_value: Number(r.extended_value || 0)
    }))
  }; 
}

module.exports = { valuationCurrent }; 
