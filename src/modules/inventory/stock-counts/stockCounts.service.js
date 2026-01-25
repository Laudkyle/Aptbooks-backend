const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const repo = require("./stockCounts.repository");
const txSvc = require("../transactions/transactions.service");

async function createStockCount({ orgId, actorUserId, payload }) {
  if (!payload.warehouseId || !payload.countDate) throw new AppError(400, "warehouseId and countDate are required");
  const created = await repo.createStockCount(orgId, payload, actorUserId);
  return created;
}

async function listStockCounts({ orgId, query }) {
  return repo.listStockCounts(orgId, query);
}

async function getStockCount({ orgId, id }) {
  const sc = await repo.getStockCount(orgId, id);
  if (!sc) throw new AppError(404, "Stock count not found");
  const lines = await repo.listLines(id);
  return { ...sc, lines };
}

async function recordLines({ orgId, actorUserId, id, lines }) {
  const sc = await repo.getStockCount(orgId, id);
  if (!sc) throw new AppError(404, "Stock count not found");
  if (sc.status !== 'draft') throw new AppError(409, "Only draft stock counts can be edited");
  if (!Array.isArray(lines) || !lines.length) throw new AppError(400, "lines[] is required");
  for (const l of lines) {
    if (!l.itemId) throw new AppError(400, "itemId required");
    if (l.countedQty == null) throw new AppError(400, "countedQty required");
    await repo.upsertLine(id, l.itemId, l.countedQty, l.unitCost);
  }
  return getStockCount({ orgId, id });
}

async function submit({ orgId, actorUserId, id }) {
  const sc = await repo.getStockCount(orgId, id);
  if (!sc) throw new AppError(404, "Stock count not found");
  if (sc.status !== 'draft') throw new AppError(409, "Only draft counts can be submitted");
  const lines = await repo.listLines(id);
  if (!lines.length) throw new AppError(409, "Cannot submit stock count with no lines");
  return repo.setStatus(orgId, id, 'submitted', actorUserId);
}

async function approve({ orgId, actorUserId, id }) {
  const sc = await repo.getStockCount(orgId, id);
  if (!sc) throw new AppError(404, "Stock count not found");
  if (sc.status !== 'submitted') throw new AppError(409, "Only submitted counts can be approved");
  return repo.setStatus(orgId, id, 'approved', actorUserId);
}

async function post({ orgId, actorUserId, id, payload }) {
  const sc = await repo.getStockCount(orgId, id);
  if (!sc) throw new AppError(404, "Stock count not found");
  if (sc.status !== 'approved') throw new AppError(409, "Only approved counts can be posted");

  if (!payload?.periodId || !payload?.txnDate) throw new AppError(400, "periodId and txnDate are required");

  // Load system balances for items in this warehouse
  const lines = await repo.listLines(id);
  const itemIds = lines.map(l => l.item_id);
  const { rows: balances } = await pool.query(
    `SELECT item_id, qty_on_hand, avg_unit_cost
     FROM inventory_balances
     WHERE organization_id=$1 AND warehouse_id=$2 AND item_id = ANY($3::uuid[])`,
    [orgId, sc.warehouse_id, itemIds]
  );
  const balMap = new Map(balances.map(b => [b.item_id, b]));

  const adjLines = [];
  for (const l of lines) {
    const bal = balMap.get(l.item_id) || { qty_on_hand: 0, avg_unit_cost: 0 };
    const systemQty = Number(bal.qty_on_hand || 0);
    const countedQty = Number(l.counted_qty || 0);
    const diff = countedQty - systemQty;
    if (diff === 0) continue;
    if (diff > 0) {
      adjLines.push({ itemId: l.item_id, quantity: diff, direction: 'increase', unitCost: l.unit_cost ?? bal.avg_unit_cost });
    } else {
      adjLines.push({ itemId: l.item_id, quantity: Math.abs(diff), direction: 'decrease' });
    }
  }

  if (!adjLines.length) {
    const updated = await repo.setStatus(orgId, id, 'posted', actorUserId, { postedTxnId: null });
    return { stockCount: updated, postedTxnId: null, note: 'no_variances' };
  }

  const draft = await txSvc.createDraftTransaction({
    orgId,
    actorUserId,
    payload: {
      periodId: payload.periodId,
      txnDate: payload.txnDate,
      txnType: 'adjustment',
      sourceWarehouseId: sc.warehouse_id,
      reference: payload.reference || sc.reference || `STOCK-COUNT:${id}`,
      memo: payload.memo || sc.memo || `Stock count adjustment (${id})`,
      lines: adjLines,
    },
  });

  await txSvc.approveTransaction({ orgId, actorUserId, transactionId: draft.transactionId });
  const posted = await txSvc.postApprovedTransaction({ orgId, actorUserId, transactionId: draft.transactionId });

  const updated = await repo.setStatus(orgId, id, 'posted', actorUserId, { postedTxnId: posted.transactionId });
  return { stockCount: updated, postedTxnId: posted.transactionId };
}

module.exports = {
  createStockCount,
  listStockCounts,
  getStockCount,
  recordLines,
  submit,
  approve,
  post,
};
