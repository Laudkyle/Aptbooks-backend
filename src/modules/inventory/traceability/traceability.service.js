const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const repo = require('./traceability.repository');

function round6(n) { return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6; }

async function listBatches({ orgId, query }) { return repo.listBatches(orgId, query); }
async function listSerials({ orgId, query }) { return repo.listSerials(orgId, query); }

async function receiveBatches({ orgId, transactionId, lineId, batches }) {
  if (!Array.isArray(batches) || !batches.length) throw new AppError(400, 'batches[] is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await repo.getTxnLineContext(client, orgId, transactionId, lineId);
    if (!ctx) throw new AppError(404, 'Transaction line not found');
    if (!['receipt','adjustment'].includes(ctx.txn_type)) throw new AppError(409, 'Batches can only be received against receipt or adjustment lines');
    const warehouseId = ctx.dest_warehouse_id || ctx.source_warehouse_id;
    const total = round6(batches.reduce((s, b) => s + Number(b.quantity || 0), 0));
    if (total !== round6(ctx.quantity)) throw new AppError(409, 'Batch quantity total must equal transaction line quantity');
    const created = [];
    for (const b of batches) {
      if (!b.batchNo || !(Number(b.quantity) > 0)) throw new AppError(400, 'Each batch requires batchNo and quantity > 0');
      const row = await repo.upsertBatch(client, orgId, warehouseId, ctx.item_id, b.batchNo, b.manufactureDate, b.expiryDate, Number(b.quantity));
      await repo.insertLink(client, orgId, lineId, row.id, null, Number(b.quantity), 'in');
      created.push(row);
    }
    await client.query('COMMIT');
    return created;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function issueBatches({ orgId, transactionId, lineId, allocations }) {
  if (!Array.isArray(allocations) || !allocations.length) throw new AppError(400, 'allocations[] is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await repo.getTxnLineContext(client, orgId, transactionId, lineId);
    if (!ctx) throw new AppError(404, 'Transaction line not found');
    const total = round6(allocations.reduce((s, a) => s + Number(a.quantity || 0), 0));
    if (total !== round6(ctx.quantity)) throw new AppError(409, 'Allocation quantity total must equal transaction line quantity');
    for (const a of allocations) {
      const batch = await repo.getBatch(client, orgId, a.batchId);
      if (!batch) throw new AppError(404, 'Batch not found');
      if (batch.item_id !== ctx.item_id) throw new AppError(409, 'Batch item mismatch');
      if (batch.warehouse_id !== (ctx.source_warehouse_id || batch.warehouse_id)) throw new AppError(409, 'Batch warehouse mismatch');
      if (Number(batch.qty_on_hand) < Number(a.quantity)) throw new AppError(409, 'Insufficient batch quantity');
      await repo.updateBatchQty(client, batch.id, round6(Number(batch.qty_on_hand) - Number(a.quantity)), round6(Number(batch.qty_on_hand) - Number(a.quantity)) > 0 ? 'active' : 'depleted');
      await repo.insertLink(client, orgId, lineId, batch.id, null, Number(a.quantity), ctx.txn_type === 'transfer' ? 'move' : 'out');
      if (ctx.txn_type === 'transfer') {
        await repo.upsertBatch(client, orgId, ctx.dest_warehouse_id, ctx.item_id, batch.batch_no, batch.manufacture_date, batch.expiry_date, Number(a.quantity));
      }
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function receiveSerials({ orgId, transactionId, lineId, serialNumbers, batchId = null }) {
  if (!Array.isArray(serialNumbers) || !serialNumbers.length) throw new AppError(400, 'serialNumbers[] is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await repo.getTxnLineContext(client, orgId, transactionId, lineId);
    if (!ctx) throw new AppError(404, 'Transaction line not found');
    if (round6(serialNumbers.length) !== round6(ctx.quantity)) throw new AppError(409, 'Serial count must equal transaction line quantity');
    const warehouseId = ctx.dest_warehouse_id || ctx.source_warehouse_id;
    const created = [];
    for (const serialNo of serialNumbers) {
      const serial = await repo.insertSerial(client, orgId, { warehouseId, itemId: ctx.item_id, batchId, serialNo, status: 'in_stock' });
      await repo.insertLink(client, orgId, lineId, batchId, serial.id, 1, 'in');
      created.push(serial);
    }
    await client.query('COMMIT');
    return created;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function issueSerials({ orgId, transactionId, lineId, serialIds }) {
  if (!Array.isArray(serialIds) || !serialIds.length) throw new AppError(400, 'serialIds[] is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await repo.getTxnLineContext(client, orgId, transactionId, lineId);
    if (!ctx) throw new AppError(404, 'Transaction line not found');
    if (round6(serialIds.length) !== round6(ctx.quantity)) throw new AppError(409, 'Serial count must equal transaction line quantity');
    for (const serialId of serialIds) {
      const serial = await repo.getSerial(client, orgId, serialId);
      if (!serial) throw new AppError(404, 'Serial not found');
      if (serial.item_id !== ctx.item_id) throw new AppError(409, 'Serial item mismatch');
      if (serial.warehouse_id !== (ctx.source_warehouse_id || serial.warehouse_id)) throw new AppError(409, 'Serial warehouse mismatch');
      if (ctx.txn_type === 'transfer') {
        await repo.updateSerial(client, serialId, { warehouseId: ctx.dest_warehouse_id, status: 'transferred' });
        await repo.insertLink(client, orgId, lineId, null, serialId, 1, 'move');
      } else {
        await repo.updateSerial(client, serialId, { warehouseId: null, status: 'issued' });
        await repo.insertLink(client, orgId, lineId, null, serialId, 1, 'out');
      }
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

module.exports = { listBatches, listSerials, receiveBatches, issueBatches, receiveSerials, issueSerials };
