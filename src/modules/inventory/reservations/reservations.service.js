const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const repo = require('./reservations.repository');

function round6(n) { return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6; }

async function assertRefs(client, orgId, warehouseId, itemId) {
  const [{ rows: wRows }, { rows: iRows }] = await Promise.all([
    client.query(`SELECT id FROM warehouses WHERE organization_id=$1 AND id=$2`, [orgId, warehouseId]),
    client.query(`SELECT id FROM inventory_items WHERE organization_id=$1 AND id=$2`, [orgId, itemId])
  ]);
  if (!wRows.length) throw new AppError(404, 'Warehouse not found');
  if (!iRows.length) throw new AppError(404, 'Inventory item not found');
}

async function getAvailability({ orgId, warehouseId, itemId, client = null }) {
  const db = client || pool;
  const snap = await repo.getBalanceSnapshot(db, orgId, warehouseId, itemId);
  const onHand = Number(snap.qty_on_hand || 0);
  const reserved = Number(snap.qty_reserved || 0);
  return { qtyOnHand: round6(onHand), qtyReserved: round6(reserved), qtyAvailable: round6(onHand - reserved) };
}

async function createReservation({ orgId, actorUserId, payload }) {
  if (!payload?.warehouseId || !payload?.itemId || !payload?.quantity) throw new AppError(400, 'warehouseId, itemId and quantity are required');
  const quantity = Number(payload.quantity);
  if (!(quantity > 0)) throw new AppError(400, 'quantity must be > 0');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertRefs(client, orgId, payload.warehouseId, payload.itemId);
    const availability = await getAvailability({ orgId, warehouseId: payload.warehouseId, itemId: payload.itemId, client });
    if (availability.qtyAvailable < quantity) throw new AppError(409, 'Insufficient available stock to reserve');
    const created = await repo.createReservation(client, orgId, { ...payload, quantity, actorUserId });
    await client.query('COMMIT');
    return { reservation: created, availabilityAfter: await getAvailability({ orgId, warehouseId: payload.warehouseId, itemId: payload.itemId }) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function listReservations({ orgId, query }) { return repo.listReservations(orgId, query); }

async function releaseReservation({ orgId, actorUserId, reservationId, mode = 'released' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await repo.getReservation(orgId, reservationId, client);
    if (!current) throw new AppError(404, 'Reservation not found');
    if (current.status !== 'active') throw new AppError(409, 'Only active reservations can be changed');
    const updated = await repo.closeReservation(client, orgId, reservationId, mode, actorUserId);
    await client.query('COMMIT');
    return updated;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

module.exports = { getAvailability, createReservation, listReservations, releaseReservation };
