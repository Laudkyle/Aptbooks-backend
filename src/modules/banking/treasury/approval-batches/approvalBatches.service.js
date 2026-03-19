
const repo = require('./approvalBatches.repository');
const paymentRunsRepo = require('../payment-runs/paymentRuns.repository');
const bankTransfersRepo = require('../bank-transfers/bankTransfers.repository');
const { AppError } = require('../../../../shared/errors/AppError');
const { withTransaction } = require('../../../../db/tx');
const { genCode } = require('../_shared/helpers');

async function list(orgId) { return repo.list(orgId); }
async function get(orgId, batchId) {
  const batch = await repo.get(orgId, batchId);
  if (!batch) throw new AppError(404, 'Approval batch not found');
  const items = await repo.getItems(orgId, batchId);
  return { ...batch, items };
}

async function create(orgId, actorUserId, payload) {
  if (!payload?.name) throw new AppError(400, 'name is required');
  return repo.create(orgId, {
    batchNo: payload.batchNo || payload.batch_no || genCode('PAB'),
    name: payload.name,
    scheduledDate: payload.scheduledDate || payload.scheduled_date || null,
    notes: payload.notes || null
  }, actorUserId);
}

async function addItems(orgId, batchId, payload) {
  const items = Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : []);
  if (!items.length) throw new AppError(400, 'items[] is required');
  return withTransaction(async (client) => {
    const batch = await repo.get(orgId, batchId, client);
    if (!batch) throw new AppError(404, 'Approval batch not found');
    if (batch.status !== 'draft') throw new AppError(409, 'Only draft approval batches can be edited');
    const normalized = [];
    for (const item of items) {
      const itemType = item.itemType || item.item_type;
      const itemId = item.itemId || item.item_id;
      if (!['payment_run','bank_transfer'].includes(itemType)) throw new AppError(400, 'itemType must be payment_run or bank_transfer');
      if (!itemId) throw new AppError(400, 'itemId is required');
      if (itemType === 'payment_run') {
        const row = await paymentRunsRepo.get(orgId, itemId, client);
        if (!row) throw new AppError(404, `Payment run not found: ${itemId}`);
        if (!['draft','submitted'].includes(row.status)) throw new AppError(409, 'Only draft/submitted payment runs can be added to an approval batch');
        await paymentRunsRepo.replaceStatus(orgId, itemId, row.status === 'draft' ? 'submitted' : row.status, { approvalBatchId: batchId }, client);
      } else {
        const row = await bankTransfersRepo.get(orgId, itemId, client);
        if (!row) throw new AppError(404, `Bank transfer not found: ${itemId}`);
        if (!['draft','submitted'].includes(row.status)) throw new AppError(409, 'Only draft/submitted bank transfers can be added to an approval batch');
        await bankTransfersRepo.updateStatus(orgId, itemId, row.status === 'draft' ? 'submitted' : row.status, { approvalBatchId: batchId }, client);
      }
      normalized.push({ itemType, itemId });
    }
    return repo.addItems(orgId, batchId, normalized, client);
  });
}

async function submit(orgId, batchId) {
  return withTransaction(async (client) => {
    const batch = await repo.get(orgId, batchId, client);
    if (!batch) throw new AppError(404, 'Approval batch not found');
    const items = await repo.getItems(orgId, batchId, client);
    if (!items.length) throw new AppError(409, 'Cannot submit a batch without items');
    return repo.updateStatus(orgId, batchId, 'submitted', {}, client);
  });
}

async function approve(orgId, batchId, actorUserId) {
  return withTransaction(async (client) => {
    const batch = await repo.get(orgId, batchId, client);
    if (!batch) throw new AppError(404, 'Approval batch not found');
    if (!['draft','submitted'].includes(batch.status)) throw new AppError(409, 'Only draft/submitted approval batches can be approved');
    const items = await repo.getItems(orgId, batchId, client);
    for (const item of items) {
      if (item.item_type === 'payment_run') {
        await paymentRunsRepo.replaceStatus(orgId, item.item_id, 'approved', { approvalBatchId: batchId, approvedByUserId: actorUserId }, client);
      } else if (item.item_type === 'bank_transfer') {
        await bankTransfersRepo.updateStatus(orgId, item.item_id, 'approved', { approvalBatchId: batchId, approvedByUserId: actorUserId }, client);
      }
    }
    return repo.updateStatus(orgId, batchId, 'approved', { approvedByUserId: actorUserId }, client);
  });
}

async function cancel(orgId, batchId, reason) {
  return withTransaction(async (client) => {
    const batch = await repo.get(orgId, batchId, client);
    if (!batch) throw new AppError(404, 'Approval batch not found');
    return repo.updateStatus(orgId, batchId, 'cancelled', { cancelledReason: reason || null }, client);
  });
}

module.exports = { list, get, create, addItems, submit, approve, cancel };
