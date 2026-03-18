const { pool } = require('../../../db/pool');

async function insertHeader(client, orgId, payload) {
  const { rows } = await client.query(
    `INSERT INTO inventory_transfer_requests(
        organization_id, period_id, request_date, source_warehouse_id, dest_warehouse_id,
        reference, memo, created_by
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [orgId, payload.periodId, payload.requestDate, payload.sourceWarehouseId, payload.destWarehouseId, payload.reference || null, payload.memo || null, payload.createdBy || null]
  );
  return rows[0];
}

async function insertLine(client, requestId, line) {
  const { rows } = await client.query(
    `INSERT INTO inventory_transfer_request_lines(transfer_request_id, item_id, quantity, notes)
     VALUES($1,$2,$3,$4)
     RETURNING *`,
    [requestId, line.itemId, line.quantity, line.notes || null]
  );
  return rows[0];
}

async function listRequests(orgId, query = {}, client = null) {
  const db = client || pool;
  const params = [orgId];
  const where = ['r.organization_id=$1'];
  if (query.status) { params.push(query.status); where.push(`r.status=$${params.length}`); }
  const { rows } = await db.query(
    `SELECT r.*, sw.code AS source_warehouse_code, dw.code AS dest_warehouse_code
       FROM inventory_transfer_requests r
       JOIN warehouses sw ON sw.id=r.source_warehouse_id
       JOIN warehouses dw ON dw.id=r.dest_warehouse_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.request_date DESC, r.created_at DESC`,
    params
  );
  return rows;
}

async function getRequest(orgId, requestId, client = null) {
  const db = client || pool;
  const { rows } = await db.query(`SELECT * FROM inventory_transfer_requests WHERE organization_id=$1 AND id=$2`, [orgId, requestId]);
  return rows[0] || null;
}

async function getLines(requestId, client = null) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT l.*, i.sku, i.name FROM inventory_transfer_request_lines l JOIN inventory_items i ON i.id=l.item_id WHERE l.transfer_request_id=$1 ORDER BY l.created_at ASC`,
    [requestId]
  );
  return rows;
}

async function setStatus(client, orgId, requestId, status, actorUserId, reason = null, transferTxnId = null) {
  const fields = ['status=$3', 'updated_at=NOW()'];
  const params = [orgId, requestId, status];
  let i = 4;
  if (status === 'submitted') { fields.push(`submitted_by=$${i++}`, 'submitted_at=NOW()'); params.push(actorUserId || null); }
  if (status === 'approved') { fields.push(`approved_by=$${i++}`, 'approved_at=NOW()'); params.push(actorUserId || null); }
  if (status === 'rejected') { fields.push(`rejected_by=$${i++}`, 'rejected_at=NOW()', `rejection_reason=$${i++}`); params.push(actorUserId || null, reason || null); }
  if (status === 'posted' && transferTxnId) { fields.push(`inventory_transaction_id=$${i++}`); params.push(transferTxnId); }
  const { rows } = await client.query(
    `UPDATE inventory_transfer_requests SET ${fields.join(', ')} WHERE organization_id=$1 AND id=$2 RETURNING *`,
    params
  );
  return rows[0] || null;
}

module.exports = { insertHeader, insertLine, listRequests, getRequest, getLines, setStatus };
