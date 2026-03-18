const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const repo = require('./reorder.repository');
const purchaseReqSvc = require('../../transactions/purchase-requisitions/purchaserequisitions.service');

async function listSettings({ orgId, query }) { return repo.listSettings(orgId, query); }
async function suggestions({ orgId, query }) { return repo.computeSuggestions(orgId, query); }

async function upsertSetting({ orgId, payload }) {
  if (!payload?.warehouseId || !payload?.itemId) throw new AppError(400, 'warehouseId and itemId are required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await repo.upsertSetting(client, orgId, {
      warehouseId: payload.warehouseId,
      itemId: payload.itemId,
      reorderPoint: Number(payload.reorderPoint || 0),
      reorderQuantity: Number(payload.reorderQuantity || 0),
      safetyStock: Number(payload.safetyStock || 0),
      leadTimeDays: Number(payload.leadTimeDays || 0)
    });
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function createPurchaseRequisitionFromSuggestions({ orgId, actorUserId, payload }) {
  if (!payload?.date) throw new AppError(400, 'date is required');
  const picks = Array.isArray(payload.lines) && payload.lines.length ? payload.lines : await repo.computeSuggestions(orgId, payload.filters || {});
  if (!picks.length) throw new AppError(409, 'No reorder suggestions available');
  const doc = await purchaseReqSvc.createDraft({
    orgId,
    actorUserId,
    payload: {
      date: payload.date,
      dueDate: payload.dueDate || null,
      reference: payload.reference || 'AUTO-REORDER',
      memo: payload.memo || 'Auto-generated from inventory reorder suggestions',
      lines: picks.map((x) => ({
        quantity: Number(x.recommendedQty || x.recommended_qty || 0),
        unitPrice: 0,
        lineTotal: 0,
        description: `${x.sku || ''} ${x.itemName || x.item_name || ''}`.trim(),
        meta: {
          itemId: x.itemId || x.item_id,
          warehouseId: x.warehouseId || x.warehouse_id,
          recommendedQty: Number(x.recommendedQty || x.recommended_qty || 0)
        }
      }))
    }
  });
  return doc;
}

module.exports = { listSettings, upsertSetting, suggestions, createPurchaseRequisitionFromSuggestions };
