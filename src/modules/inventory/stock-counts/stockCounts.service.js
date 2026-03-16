const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const repo = require("./stockCounts.repository");
const txSvc = require("../transactions/transactions.service");
const documentableSvc = require("../../../workflow/documents/documentable.service");

async function buildStockCountSnapshot({ orgId, id, client = null }) {
  const db = client || pool;
  const sc = await repo.getStockCount(orgId, id, db);
  if (!sc) throw new AppError(404, "Stock count not found");
  const lines = await repo.listLines(id, db);
  const itemIds = lines.map((l) => l.item_id);
  let balMap = new Map();
  if (itemIds.length) {
    const { rows: balances } = await db.query(
      `SELECT item_id, qty_on_hand, avg_unit_cost
         FROM inventory_balances
        WHERE organization_id=$1 AND warehouse_id=$2 AND item_id = ANY($3::uuid[])`,
      [orgId, sc.warehouse_id, itemIds]
    );
    balMap = new Map(balances.map((b) => [b.item_id, b]));
  }
  return {
    header: {
      id: sc.id,
      warehouse: { id: sc.warehouse_id, code: sc.warehouse_code || null, name: sc.warehouse_name || null },
      countDate: sc.count_date,
      reference: sc.reference,
      memo: sc.memo,
      status: sc.status
    },
    lines: lines.map((l) => {
      const bal = balMap.get(l.item_id) || { qty_on_hand: 0, avg_unit_cost: 0 };
      const systemQty = Number(bal.qty_on_hand || l.system_qty || 0);
      const countedQty = Number(l.counted_qty || 0);
      return {
        id: l.id,
        itemId: l.item_id,
        sku: l.sku || null,
        name: l.name || null,
        systemQty,
        countedQty,
        varianceQty: Number((countedQty - systemQty).toFixed(6)),
        unitCost: l.unit_cost == null ? Number(bal.avg_unit_cost || 0) : Number(l.unit_cost),
        valuationContext: { avgUnitCost: Number(bal.avg_unit_cost || 0) }
      };
    }),
    related: { postedTxnId: sc.posted_txn_id || null },
    meta: { source: "inventory_stock_counts" }
  };
}

async function createStockCount({ orgId, actorUserId, payload }) {
  if (!payload.warehouseId || !payload.countDate) throw new AppError(400, "warehouseId and countDate are required");
  return repo.createStockCount(orgId, payload, actorUserId);
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

async function submitStockCount({ orgId, actorUserId, id }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sc = await repo.getStockCount(orgId, id, client);
    if (!sc) throw new AppError(404, "Stock count not found");
    if (sc.status !== 'draft' && sc.status !== 'rejected') throw new AppError(409, "Only draft or rejected counts can be submitted");
    const lines = await repo.listLines(id, client);
    if (!lines.length) throw new AppError(409, "Cannot submit stock count with no lines");

    const snapshot = await buildStockCountSnapshot({ orgId, id, client });
    const doc = await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: 'stock_count',
      entity: sc,
      workflowDocumentId: sc.workflow_document_id,
      snapshot,
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await repo.setWorkflowDocumentId(orgId, id, workflowDocumentId, client);
      }
    });

    const updated = await repo.setStatus(orgId, id, 'submitted', actorUserId, {}, client);
    await client.query("COMMIT");
    return { stockCount: updated, workflowDocument: doc };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function approveStockCountWorkflow({ orgId, actorUserId, id, comment }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sc = await repo.getStockCount(orgId, id, client);
    if (!sc) throw new AppError(404, "Stock count not found");
    if (!sc.workflow_document_id) throw new AppError(409, "Stock count has no workflow document");
    if (sc.status !== 'submitted' && sc.status !== 'approved') throw new AppError(409, "Only submitted stock counts can be approved");

    const doc = await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: 'stock_count',
      workflowDocumentId: sc.workflow_document_id,
      creatorUserId: sc.created_by,
      comment,
      client
    });

    const updated = await repo.setStatus(orgId, id, 'approved', actorUserId, {}, client);
    await client.query("COMMIT");
    return { stockCount: updated, workflowDocument: doc };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function rejectStockCountWorkflow({ orgId, actorUserId, id, comment }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sc = await repo.getStockCount(orgId, id, client);
    if (!sc) throw new AppError(404, "Stock count not found");
    if (!sc.workflow_document_id) throw new AppError(409, "Stock count has no workflow document");
    if (sc.status !== 'submitted') throw new AppError(409, "Only submitted stock counts can be rejected");

    const doc = await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: 'stock_count',
      workflowDocumentId: sc.workflow_document_id,
      creatorUserId: sc.created_by,
      comment,
      client
    });

    const updated = await repo.setStatus(orgId, id, 'rejected', actorUserId, { rejectionReason: comment || null }, client);
    await client.query("COMMIT");
    return { stockCount: updated, workflowDocument: doc };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function assertStockCountApprovalStateAllowsPost({ orgId, id, client = null }) {
  const sc = await repo.getStockCount(orgId, id, client || pool);
  if (!sc) throw new AppError(404, "Stock count not found");
  await documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: 'stock_count',
    workflowDocumentId: sc.workflow_document_id,
    actionLabel: 'post',
    client: client || pool
  });
}

async function postStockCountAdjustments({ orgId, actorUserId, id, payload }) {
  const sc = await repo.getStockCount(orgId, id);
  if (!sc) throw new AppError(404, "Stock count not found");
  if (sc.status !== 'approved') throw new AppError(409, "Only approved counts can be posted");

  await assertStockCountApprovalStateAllowsPost({ orgId, id });

  if (!payload?.periodId || !payload?.txnDate) throw new AppError(400, "periodId and txnDate are required");

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

  // Stock count approval is the primary approval gate here.
  await txSvc.submitTransactionForApproval({ orgId, actorUserId, transactionId: draft.transactionId });
  await txSvc.approveTransactionWorkflow({ orgId, actorUserId, transactionId: draft.transactionId, comment: `Auto-approved from stock count ${id}` });
  const posted = await txSvc.postApprovedTransaction({ orgId, actorUserId, transactionId: draft.transactionId });

  const updated = await repo.setStatus(orgId, id, 'posted', actorUserId, { postedTxnId: posted.transactionId });
  return { stockCount: updated, postedTxnId: posted.transactionId };
}

module.exports = {
  createStockCount,
  listStockCounts,
  getStockCount,
  recordLines,
  submitStockCount,
  approveStockCountWorkflow,
  rejectStockCountWorkflow,
  assertStockCountApprovalStateAllowsPost,
  postStockCountAdjustments,
  upsertLines: async ({ orgId, actorUserId, id, payload }) => recordLines({ orgId, actorUserId, id, lines: Array.isArray(payload) ? payload : payload.lines }),
  submit: submitStockCount,
  approve: approveStockCountWorkflow,
  post: postStockCountAdjustments,
};
