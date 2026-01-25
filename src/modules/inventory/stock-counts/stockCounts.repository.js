const { pool } = require("../../../db/pool");

async function createStockCount(orgId, payload, createdBy) {
  const { rows } = await pool.query(
    `INSERT INTO inventory_stock_counts(organization_id, warehouse_id, count_date, status, reference, memo, created_by)
     VALUES($1,$2,$3,'draft',$4,$5,$6)
     RETURNING *`,
    [orgId, payload.warehouseId, payload.countDate, payload.reference || null, payload.memo || null, createdBy || null]
  );
  return rows[0];
}

async function listStockCounts(orgId, query = {}) {
  const params = [orgId];
  const where = ['sc.organization_id=$1'];
  let i = 2;
  if (query.warehouseId) { where.push(`sc.warehouse_id=$${i++}`);params.push(query.warehouseId);}
  if (query.status) { where.push(`sc.status=$${i++}`);params.push(query.status);}
  const { rows } = await pool.query(
    `SELECT sc.*,
            w.code AS warehouse_code,
            w.name AS warehouse_name
     FROM inventory_stock_counts sc
     JOIN warehouses w ON w.id=sc.warehouse_id
     WHERE ${where.join(' AND ')}
     ORDER BY sc.count_date DESC, sc.created_at DESC`,
    params
  );
  return rows;
}

async function getStockCount(orgId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM inventory_stock_counts WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  );
  return rows[0] || null;
}

async function listLines(stockCountId) {
  const { rows } = await pool.query(
    `SELECT l.*, i.sku, i.name
     FROM inventory_stock_count_lines l
     JOIN inventory_items i ON i.id=l.item_id
     WHERE l.stock_count_id=$1
     ORDER BY i.sku`,
    [stockCountId]
  );
  return rows;
}

async function upsertLine(stockCountId, itemId, countedQty, unitCost) {
  const { rows } = await pool.query(
    `INSERT INTO inventory_stock_count_lines(stock_count_id, item_id, counted_qty, unit_cost)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (stock_count_id, item_id)
     DO UPDATE SET counted_qty=EXCLUDED.counted_qty, unit_cost=EXCLUDED.unit_cost, updated_at=NOW()
     RETURNING *`,
    [stockCountId, itemId, countedQty, unitCost || null]
  );
  return rows[0];
}

async function setStatus(orgId, id, status, actorUserId, extra = {}) {
  const fields = [];
  const params = [orgId, id];
  let i = 3;
  fields.push(`status=$${i++}`);params.push(status);
  if (status === 'submitted') { fields.push(`submitted_at=NOW()`);fields.push(`submitted_by=$${i++}`);params.push(actorUserId);}
  if (status === 'approved') { fields.push(`approved_at=NOW()`);fields.push(`approved_by=$${i++}`);params.push(actorUserId);}
  if (status === 'posted') { fields.push(`posted_at=NOW()`);fields.push(`posted_by=$${i++}`);params.push(actorUserId);}
  if (extra.postedTxnId) { fields.push(`posted_txn_id=$${i++}`);params.push(extra.postedTxnId);}
  const { rows } = await pool.query(
    `UPDATE inventory_stock_counts SET ${fields.join(', ')}, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    params
  );
  return rows[0] || null;
}

module.exports = {
  createStockCount,
  listStockCounts,
  getStockCount,
  listLines,
  upsertLine,
  setStatus,
};
