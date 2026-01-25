const { pool } = require("../../../db/pool"); 

async function inventoryValuation(orgId, { warehouseId } = {}) {
  const params = [orgId]; 
  let where = "WHERE b.organization_id=$1"; 
  if (warehouseId) { params.push(warehouseId);  where += ` AND b.warehouse_id=$${params.length}`;  }

  const { rows } = await pool.query(
    `
    SELECT b.warehouse_id, w.code AS warehouse_code,
           b.item_id, i.sku, i.name,
           b.qty_on_hand, b.avg_unit_cost,
           (b.qty_on_hand * b.avg_unit_cost) AS extended_value
    FROM inventory_balances b
    JOIN warehouses w ON w.id=b.warehouse_id
    JOIN inventory_items i ON i.id=b.item_id
    ${where}
    ORDER BY w.code, i.sku
    `,
    params
  ); 
  return rows; 
}

async function inventoryMovements(orgId, { from, to, warehouseId, itemId } = {}) {
  const params=[orgId]; 
  let where="WHERE t.organization_id=$1"; 
  if (from) { params.push(from);  where += ` AND t.txn_date >= $${params.length}`;  }
  if (to) { params.push(to);  where += ` AND t.txn_date <= $${params.length}`;  }
  if (warehouseId) { params.push(warehouseId);  where += ` AND (t.source_warehouse_id=$${params.length} OR t.dest_warehouse_id=$${params.length})`;  }
  if (itemId) { params.push(itemId);  where += ` AND EXISTS (SELECT 1 FROM inventory_transaction_lines l WHERE l.transaction_id=t.id AND l.item_id=$${params.length})`;  }

  const { rows } = await pool.query(
    `
    SELECT t.id, t.txn_date, t.txn_type, t.source_warehouse_id, t.dest_warehouse_id, t.reference, t.memo, t.journal_entry_id
    FROM inventory_transactions t
    ${where}
    ORDER BY t.txn_date DESC, t.created_at DESC
    LIMIT 500
    `,
    params
  ); 
  return rows; 
}

module.exports = { inventoryValuation, inventoryMovements }; 
