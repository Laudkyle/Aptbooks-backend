const { pool } = require('../../../db/pool');

async function getBalanceSnapshot(db, orgId, warehouseId, itemId) {
  const { rows } = await db.query(
    `SELECT COALESCE((SELECT qty_on_hand FROM inventory_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3),0) AS qty_on_hand,
            COALESCE((SELECT SUM(qty_reserved) FROM inventory_reservations WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3 AND status='active'),0) AS qty_reserved`,
    [orgId, warehouseId, itemId]
  );
  return rows[0];
}

async function createReservation(client, orgId, payload) {
  const { rows } = await client.query(
    `INSERT INTO inventory_reservations(
        organization_id, warehouse_id, item_id, source_document_id, reserved_for_type, reserved_for_id,
        reference, notes, qty_reserved, status, expires_at, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11)
     RETURNING *`,
    [orgId, payload.warehouseId, payload.itemId, payload.sourceDocumentId || null, payload.reservedForType || null, payload.reservedForId || null, payload.reference || null, payload.notes || null, payload.quantity, payload.expiresAt || null, payload.actorUserId || null]
  );
  return rows[0];
}

async function listReservations(orgId, query = {}, client = null) {
  const db = client || pool;
  const params = [orgId];
  const where = ['r.organization_id=$1'];
  if (query.status) { params.push(query.status); where.push(`r.status=$${params.length}`); }
  if (query.warehouseId) { params.push(query.warehouseId); where.push(`r.warehouse_id=$${params.length}`); }
  if (query.itemId) { params.push(query.itemId); where.push(`r.item_id=$${params.length}`); }
  const { rows } = await db.query(
    `SELECT r.*, w.code AS warehouse_code, i.sku, i.name AS item_name
       FROM inventory_reservations r
       JOIN warehouses w ON w.id=r.warehouse_id
       JOIN inventory_items i ON i.id=r.item_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC`,
    params
  );
  return rows;
}

async function getReservation(orgId, reservationId, client = null) {
  const db = client || pool;
  const { rows } = await db.query(`SELECT * FROM inventory_reservations WHERE organization_id=$1 AND id=$2`, [orgId, reservationId]);
  return rows[0] || null;
}

async function closeReservation(client, orgId, reservationId, nextStatus, actorUserId) {
  const { rows } = await client.query(
    `UPDATE inventory_reservations
        SET status=$3, released_by=$4, released_at=NOW(), updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, reservationId, nextStatus, actorUserId || null]
  );
  return rows[0] || null;
}

module.exports = { getBalanceSnapshot, createReservation, listReservations, getReservation, closeReservation };
