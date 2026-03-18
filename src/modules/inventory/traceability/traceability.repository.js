const { pool } = require('../../../db/pool');

async function listBatches(orgId, query = {}, client = null) {
  const db = client || pool;
  const params = [orgId];
  const where = ['b.organization_id=$1'];
  if (query.warehouseId) { params.push(query.warehouseId); where.push(`b.warehouse_id=$${params.length}`); }
  if (query.itemId) { params.push(query.itemId); where.push(`b.item_id=$${params.length}`); }
  const { rows } = await db.query(
    `SELECT b.*, w.code AS warehouse_code, i.sku, i.name AS item_name
       FROM inventory_batches b
       JOIN warehouses w ON w.id=b.warehouse_id
       JOIN inventory_items i ON i.id=b.item_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.updated_at DESC`,
    params
  );
  return rows;
}

async function listSerials(orgId, query = {}, client = null) {
  const db = client || pool;
  const params = [orgId];
  const where = ['s.organization_id=$1'];
  if (query.warehouseId) { params.push(query.warehouseId); where.push(`s.warehouse_id=$${params.length}`); }
  if (query.itemId) { params.push(query.itemId); where.push(`s.item_id=$${params.length}`); }
  const { rows } = await db.query(
    `SELECT s.*, i.sku, i.name AS item_name, w.code AS warehouse_code
       FROM inventory_serial_numbers s
       JOIN inventory_items i ON i.id=s.item_id
       LEFT JOIN warehouses w ON w.id=s.warehouse_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.updated_at DESC`,
    params
  );
  return rows;
}

async function getTxnLineContext(client, orgId, transactionId, lineId) {
  const { rows } = await client.query(
    `SELECT t.id AS transaction_id, t.txn_type, t.source_warehouse_id, t.dest_warehouse_id,
            l.id AS line_id, l.item_id, l.quantity
       FROM inventory_transactions t
       JOIN inventory_transaction_lines l ON l.transaction_id=t.id
      WHERE t.organization_id=$1 AND t.id=$2 AND l.id=$3`,
    [orgId, transactionId, lineId]
  );
  return rows[0] || null;
}

async function upsertBatch(client, orgId, warehouseId, itemId, batchNo, manufactureDate, expiryDate, qtyDelta) {
  const { rows } = await client.query(
    `INSERT INTO inventory_batches(organization_id, warehouse_id, item_id, batch_no, manufacture_date, expiry_date, qty_on_hand, status)
     VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7 > 0 THEN 'active' ELSE 'depleted' END)
     ON CONFLICT (organization_id, warehouse_id, item_id, batch_no)
     DO UPDATE SET qty_on_hand = inventory_batches.qty_on_hand + EXCLUDED.qty_on_hand,
                   manufacture_date = COALESCE(EXCLUDED.manufacture_date, inventory_batches.manufacture_date),
                   expiry_date = COALESCE(EXCLUDED.expiry_date, inventory_batches.expiry_date),
                   status = CASE WHEN inventory_batches.qty_on_hand + EXCLUDED.qty_on_hand > 0 THEN 'active' ELSE 'depleted' END,
                   updated_at = NOW()
     RETURNING *`,
    [orgId, warehouseId, itemId, batchNo, manufactureDate || null, expiryDate || null, qtyDelta]
  );
  return rows[0];
}

async function getBatch(client, orgId, batchId) {
  const { rows } = await client.query(`SELECT * FROM inventory_batches WHERE organization_id=$1 AND id=$2`, [orgId, batchId]);
  return rows[0] || null;
}

async function updateBatchQty(client, batchId, qtyOnHand, status) {
  const { rows } = await client.query(`UPDATE inventory_batches SET qty_on_hand=$2, status=$3, updated_at=NOW() WHERE id=$1 RETURNING *`, [batchId, qtyOnHand, status]);
  return rows[0] || null;
}

async function insertSerial(client, orgId, payload) {
  const { rows } = await client.query(
    `INSERT INTO inventory_serial_numbers(organization_id, warehouse_id, item_id, batch_id, serial_no, status)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [orgId, payload.warehouseId || null, payload.itemId, payload.batchId || null, payload.serialNo, payload.status || 'in_stock']
  );
  return rows[0];
}

async function getSerial(client, orgId, serialId) {
  const { rows } = await client.query(`SELECT * FROM inventory_serial_numbers WHERE organization_id=$1 AND id=$2`, [orgId, serialId]);
  return rows[0] || null;
}

async function updateSerial(client, serialId, patch) {
  const current = await client.query(`SELECT * FROM inventory_serial_numbers WHERE id=$1`, [serialId]);
  if (!current.rows.length) return null;
  const c = current.rows[0];
  const { rows } = await client.query(
    `UPDATE inventory_serial_numbers
        SET warehouse_id=$2, batch_id=$3, status=$4, updated_at=NOW()
      WHERE id=$1
      RETURNING *`,
    [serialId, patch.warehouseId === undefined ? c.warehouse_id : patch.warehouseId, patch.batchId === undefined ? c.batch_id : patch.batchId, patch.status || c.status]
  );
  return rows[0] || null;
}

async function insertLink(client, orgId, transactionLineId, batchId, serialId, quantity, direction) {
  await client.query(
    `INSERT INTO inventory_traceability_links(organization_id, transaction_line_id, batch_id, serial_id, quantity, direction)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [orgId, transactionLineId, batchId || null, serialId || null, quantity == null ? null : quantity, direction]
  );
}

module.exports = { listBatches, listSerials, getTxnLineContext, upsertBatch, getBatch, updateBatchQty, insertSerial, getSerial, updateSerial, insertLink };
