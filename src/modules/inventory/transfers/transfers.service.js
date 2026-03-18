const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const repo = require('./transfers.repository');
const txnSvc = require('../transactions/transactions.service');

async function assertRefs(client, orgId, payload) {
  if (payload.sourceWarehouseId === payload.destWarehouseId) throw new AppError(400, 'sourceWarehouseId cannot equal destWarehouseId');
  const { rows: whRows } = await client.query(
    `SELECT id FROM warehouses WHERE organization_id=$1 AND id = ANY($2::uuid[])`,
    [orgId, [payload.sourceWarehouseId, payload.destWarehouseId]]
  );
  if (whRows.length !== 2) throw new AppError(404, 'One or more warehouses not found');
  const { rows: pRows } = await client.query(`SELECT id, status FROM accounting_periods WHERE organization_id=$1 AND id=$2`, [orgId, payload.periodId]);
  if (!pRows.length) throw new AppError(404, 'Accounting period not found');
  if (pRows[0].status !== 'open') throw new AppError(409, 'Accounting period is not open');
}

async function createRequest({ orgId, actorUserId, payload }) {
  if (!payload?.periodId || !payload?.requestDate || !payload?.sourceWarehouseId || !payload?.destWarehouseId) {
    throw new AppError(400, 'periodId, requestDate, sourceWarehouseId and destWarehouseId are required');
  }
  if (!Array.isArray(payload.lines) || !payload.lines.length) throw new AppError(400, 'lines[] is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertRefs(client, orgId, payload);
    const header = await repo.insertHeader(client, orgId, { ...payload, createdBy: actorUserId });
    for (const line of payload.lines) {
      if (!line.itemId || !(Number(line.quantity) > 0)) throw new AppError(400, 'Each line requires itemId and quantity > 0');
      await repo.insertLine(client, header.id, { itemId: line.itemId, quantity: Number(line.quantity), notes: line.notes || null });
    }
    await client.query('COMMIT');
    return getRequest({ orgId, requestId: header.id });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function listRequests({ orgId, query }) { return repo.listRequests(orgId, query); }

async function getRequest({ orgId, requestId }) {
  const header = await repo.getRequest(orgId, requestId);
  if (!header) throw new AppError(404, 'Transfer request not found');
  const lines = await repo.getLines(requestId);
  return { header, lines };
}

async function transition({ orgId, actorUserId, requestId, targetStatus, reason = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await repo.getRequest(orgId, requestId, client);
    if (!current) throw new AppError(404, 'Transfer request not found');
    if (targetStatus === 'submitted' && !['draft','rejected'].includes(current.status)) throw new AppError(409, 'Only draft or rejected requests can be submitted');
    if (targetStatus === 'approved' && current.status !== 'submitted') throw new AppError(409, 'Only submitted requests can be approved');
    if (targetStatus === 'rejected' && current.status !== 'submitted') throw new AppError(409, 'Only submitted requests can be rejected');
    if (targetStatus === 'cancelled' && ['posted','cancelled'].includes(current.status)) throw new AppError(409, 'Request can no longer be cancelled');
    const updated = await repo.setStatus(client, orgId, requestId, targetStatus, actorUserId, reason);
    await client.query('COMMIT');
    return updated;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function postRequest({ orgId, actorUserId, requestId }) {
  const current = await repo.getRequest(orgId, requestId);
  if (!current) throw new AppError(404, 'Transfer request not found');
  if (current.status !== 'approved') throw new AppError(409, 'Only approved transfer requests can be posted');
  if (current.inventory_transaction_id) return { requestId, inventoryTransactionId: current.inventory_transaction_id };
  const lines = await repo.getLines(requestId);
  const created = await txnSvc.createDraftTransaction({
    orgId,
    actorUserId,
    payload: {
      periodId: current.period_id,
      txnDate: current.request_date,
      txnType: 'transfer',
      sourceWarehouseId: current.source_warehouse_id,
      destWarehouseId: current.dest_warehouse_id,
      reference: current.reference || `TRF:${current.id}`,
      memo: current.memo || 'Transfer request posting',
      lines: lines.map((l) => ({ itemId: l.item_id, quantity: Number(l.quantity) }))
    }
  });
  await txnSvc.submitTransactionForApproval({ orgId, actorUserId, transactionId: created.transactionId });
  await txnSvc.approveTransactionWorkflow({ orgId, actorUserId, transactionId: created.transactionId, comment: 'Auto-approved from transfer request' });
  const posted = await txnSvc.postApprovedTransaction({ orgId, actorUserId, transactionId: created.transactionId, bypassApprovalCheck: true });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await repo.setStatus(client, orgId, requestId, 'posted', actorUserId, null, posted.transactionId);
    await client.query('COMMIT');
    return { request: updated, inventoryTransactionId: posted.transactionId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

module.exports = { createRequest, listRequests, getRequest, transition, postRequest };
