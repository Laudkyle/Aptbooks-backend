const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const repo = require("./transactions.repository");
const { getSetting, upsertSetting } = require("../inventory.settings.repository");
const { createDraftJournal, postDraftJournal } = require("../../../interfaces/journalPosting.interface");
const documentableSvc = require("../../../workflow/documents/documentable.service");

function round6(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
}

function getInventoryTxnEntityType(txnType) {
  if (txnType === "receipt") return "stock_receive";
  if (txnType === "issue") return "stock_issue";
  if (txnType === "transfer") return "stock_transfer";
  if (txnType === "adjustment") return "stock_adjustment";
  throw new AppError(400, `Unsupported inventory transaction type: ${txnType}`);
}

async function ensureCostMethod(orgId) {
  const current = await getSetting(orgId, "inventoryCostMethod");
  if (!current) {
    await upsertSetting(orgId, "inventoryCostMethod", { method: "WEIGHTED_AVERAGE", locked: false });
    return { method: "WEIGHTED_AVERAGE", locked: false };
  }
  return current;
}

async function assertPeriodOpen(client, orgId, periodId, txnDate) {
  const { rows } = await client.query(
    `SELECT id, status, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(404, "Accounting period not found");
  const p = rows[0];
  if (p.status !== "open") throw new AppError(409, "Period not open");

  const d = txnDate instanceof Date ? txnDate : new Date(txnDate);
  const start = new Date(p.start_date); start.setHours(0, 0, 0, 0);
  const end = new Date(p.end_date); end.setHours(23, 59, 59, 999);
  if (d < start || d > end) throw new AppError(409, "Transaction date outside open period");
  return p;
}

function aggregateJournalLines(lines) {
  const map = new Map();
  for (const l of lines) {
    const key = String(l.accountId);
    const prev = map.get(key) || { accountId: l.accountId, debit: 0, credit: 0, memo: l.memo };
    prev.debit += Number(l.debit || 0);
    prev.credit += Number(l.credit || 0);
    map.set(key, prev);
  }
  return Array.from(map.values()).map((x) => ({ ...x, debit: round6(x.debit), credit: round6(x.credit) }));
}

async function buildTransactionSnapshot({ orgId, transactionId, client = null }) {
  const out = await repo.getTransactionWithLines(client || pool, orgId, transactionId);
  if (!out) throw new AppError(404, "Transaction not found");
  const { txn, lines } = out;
  return {
    header: {
      id: txn.id,
      txnType: txn.txn_type,
      txnDate: txn.txn_date,
      periodId: txn.period_id,
      reference: txn.reference,
      memo: txn.memo,
      status2: txn.status2,
      sourceWarehouse: txn.source_warehouse_id ? {
        id: txn.source_warehouse_id,
        code: txn.source_warehouse_code || null,
        name: txn.source_warehouse_name || null
      } : null,
      destWarehouse: txn.dest_warehouse_id ? {
        id: txn.dest_warehouse_id,
        code: txn.dest_warehouse_code || null,
        name: txn.dest_warehouse_name || null
      } : null
    },
    lines: lines.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      sku: l.sku || null,
      name: l.name || null,
      quantity: Number(l.quantity || 0),
      direction: l.direction || null,
      unitCost: l.unit_cost == null ? null : Number(l.unit_cost),
      extendedCost: l.extended_cost == null ? null : Number(l.extended_cost)
    })),
    valuation_context: {
      costMethod: await ensureCostMethod(orgId)
    },
    related: {
      journalEntryId: txn.journal_entry_id || null,
      workflowDocumentId: txn.workflow_document_id || null
    },
    meta: {
      source: "inventory_transactions"
    }
  };
}

async function createDraftTransaction({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!payload?.periodId || !payload?.txnDate || !payload?.txnType) {
      throw new AppError(400, "periodId, txnDate, txnType are required");
    }
    await assertPeriodOpen(client, orgId, payload.periodId, payload.txnDate);

    const txnType = payload.txnType;
    const lines = payload.lines || [];
    if (!Array.isArray(lines) || !lines.length) throw new AppError(400, "lines[] is required");

    if (txnType === "receipt" && !payload.destWarehouseId) throw new AppError(400, "destWarehouseId is required for receipt");
    if (txnType === "issue" && !payload.sourceWarehouseId) throw new AppError(400, "sourceWarehouseId is required for issue");
    if (txnType === "transfer") {
      if (!payload.sourceWarehouseId || !payload.destWarehouseId) throw new AppError(400, "sourceWarehouseId and destWarehouseId are required for transfer");
      if (payload.sourceWarehouseId === payload.destWarehouseId) throw new AppError(400, "sourceWarehouseId cannot equal destWarehouseId");
    }
    if (txnType === "adjustment" && !payload.sourceWarehouseId) throw new AppError(400, "sourceWarehouseId is required for adjustment");

    const txn = await repo.insertDraftTransaction(client, orgId, {
      periodId: payload.periodId,
      txnDate: payload.txnDate,
      txnType,
      sourceWarehouseId: payload.sourceWarehouseId || null,
      destWarehouseId: payload.destWarehouseId || null,
      reference: payload.reference,
      memo: payload.memo,
      idempotencyKey: payload.idempotencyKey,
      createdBy: actorUserId,
    });

    for (const l of lines) {
      if (!l.itemId || l.quantity == null) throw new AppError(400, "Each line requires itemId and quantity");
      if (Number(l.quantity) <= 0) throw new AppError(400, "quantity must be > 0");
      if (txnType === "receipt" && l.unitCost == null) throw new AppError(400, "unitCost is required for receipt lines");
      if (txnType === "adjustment") {
        if (l.direction !== "increase" && l.direction !== "decrease") throw new AppError(400, "direction must be 'increase' or 'decrease'");
      }
      await repo.insertTxnLine(client, txn.id, {
        itemId: l.itemId,
        quantity: Number(l.quantity),
        unitCost: l.unitCost == null ? null : Number(l.unitCost),
        extendedCost: null,
        direction: l.direction || null,
      });
    }

    await client.query("COMMIT");
    return { transactionId: txn.id, status2: "draft" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function listTransactions({ orgId, query }) {
  return repo.listTransactions(orgId, query);
}

async function getTransaction({ orgId, transactionId }) {
  const out = await repo.getTransactionWithLines(orgId, transactionId);
  if (!out) throw new AppError(404, "Transaction not found");
  return out;
}

async function submitTransactionForApproval({ orgId, actorUserId, transactionId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await repo.getTransactionWithLines(client, orgId, transactionId);
    if (!out) throw new AppError(404, "Transaction not found");
    const { txn } = out;
    if (txn.status2 !== "draft" && txn.status2 !== "rejected") throw new AppError(409, "Only draft or rejected transactions can be submitted");

    const entityType = getInventoryTxnEntityType(txn.txn_type);
    const snapshot = await buildTransactionSnapshot({ orgId, transactionId, client });
    const doc = await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType,
      entity: txn,
      workflowDocumentId: txn.workflow_document_id,
      snapshot,
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await repo.setWorkflowDocumentId(client, orgId, transactionId, workflowDocumentId);
      }
    });

    const updated = await repo.setStatus2(client, orgId, transactionId, "submitted", actorUserId);
    await client.query("COMMIT");
    return { transaction: updated, workflowDocument: doc };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function approveTransactionWorkflow({ orgId, actorUserId, transactionId, comment }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await repo.getTransactionWithLines(client, orgId, transactionId);
    if (!out) throw new AppError(404, "Transaction not found");
    const { txn } = out;
    if (!txn.workflow_document_id) throw new AppError(409, "Transaction has no workflow document");
    if (txn.status2 !== "submitted" && txn.status2 !== "approved") throw new AppError(409, "Only submitted transactions can be approved");

    const doc = await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: getInventoryTxnEntityType(txn.txn_type),
      workflowDocumentId: txn.workflow_document_id,
      creatorUserId: txn.created_by,
      comment,
      client
    });

    const updated = await repo.setStatus2(client, orgId, transactionId, "approved", actorUserId);
    await client.query("COMMIT");
    return { transaction: updated, workflowDocument: doc };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function rejectTransactionWorkflow({ orgId, actorUserId, transactionId, comment }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await repo.getTransactionWithLines(client, orgId, transactionId);
    if (!out) throw new AppError(404, "Transaction not found");
    const { txn } = out;
    if (!txn.workflow_document_id) throw new AppError(409, "Transaction has no workflow document");
    if (txn.status2 !== "submitted") throw new AppError(409, "Only submitted transactions can be rejected");

    const doc = await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: getInventoryTxnEntityType(txn.txn_type),
      workflowDocumentId: txn.workflow_document_id,
      creatorUserId: txn.created_by,
      comment,
      client
    });

    const updated = await repo.setStatus2(client, orgId, transactionId, "rejected", actorUserId, comment || null);
    await client.query("COMMIT");
    return { transaction: updated, workflowDocument: doc };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function assertTransactionApprovalStateAllowsPost({ orgId, transactionId, client = null }) {
  const out = await repo.getTransactionWithLines(client || pool, orgId, transactionId);
  if (!out) throw new AppError(404, "Transaction not found");
  await documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: getInventoryTxnEntityType(out.txn.txn_type),
    workflowDocumentId: out.txn.workflow_document_id,
    actionLabel: "post",
    client: client || pool
  });
}

async function approveTransaction({ orgId, actorUserId, transactionId, comment }) {
  return approveTransactionWorkflow({ orgId, actorUserId, transactionId, comment });
}

async function voidTransaction({ orgId, actorUserId, transactionId, reason }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, status2 FROM inventory_transactions WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, transactionId]
    );
    if (!rows.length) throw new AppError(404, "Transaction not found");
    const st = rows[0].status2;
    if (st === "posted") throw new AppError(409, "Posted transactions must be reversed, not voided");
    if (st === "voided") return { transactionId, status2: "voided" };
    const updated = await repo.setStatus2(client, orgId, transactionId, "voided", actorUserId, reason || null);
    await client.query(`UPDATE inventory_transactions SET status='void' WHERE organization_id=$1 AND id=$2`, [orgId, transactionId]);
    await client.query("COMMIT");
    return { transactionId, status2: updated.status2 || "voided" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function postApprovedTransaction({ orgId, actorUserId, transactionId, bypassApprovalCheck = false }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT * FROM inventory_transactions WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, transactionId]
    );
    if (!locked.rows.length) throw new AppError(404, "Transaction not found");
    const txn = locked.rows[0];
    if (txn.status2 !== "approved") throw new AppError(409, "Only approved transactions can be posted");
    if (txn.journal_entry_id) throw new AppError(409, "Transaction already posted");

    if (!bypassApprovalCheck) {
      await assertTransactionApprovalStateAllowsPost({ orgId, transactionId, client });
    }

    const { method } = await ensureCostMethod(orgId);
    await assertPeriodOpen(client, orgId, txn.period_id, txn.txn_date);

    const { rows: lineRows } = await client.query(
      `SELECT id, item_id, quantity, unit_cost, direction FROM inventory_transaction_lines WHERE transaction_id=$1 ORDER BY created_at ASC`,
      [transactionId]
    );
    if (!lineRows.length) throw new AppError(409, "Transaction has no lines");

    const itemIds = lineRows.map((l) => l.item_id);
    const items = await repo.getItemsWithAccounts(orgId, itemIds, client);
    const itemMap = new Map(items.map((r) => [r.item_id, r]));
    for (const l of lineRows) {
      if (!itemMap.has(l.item_id)) throw new AppError(400, `Unknown itemId ${l.item_id}`);
      if (Number(l.quantity) <= 0) throw new AppError(400, "quantity must be > 0");
    }

    const journalLines = [];
    const getBal = (warehouseId, itemId) => repo.getBalanceForUpdate(client, orgId, warehouseId, itemId);

    const txnType = txn.txn_type;

    if (txnType === "receipt") {
      if (!txn.dest_warehouse_id) throw new AppError(400, "destWarehouseId is required for receipt");
      for (const l of lineRows) {
        if (l.unit_cost == null) throw new AppError(400, "unitCost is required for receipt lines");
        const bal = await getBal(txn.dest_warehouse_id, l.item_id);
        const qty = Number(l.quantity);
        const unitCost = Number(l.unit_cost);
        const ext = round6(qty * unitCost);

        const oldQty = Number(bal.qty_on_hand);
        const oldAvg = Number(bal.avg_unit_cost);
        const newQty = round6(oldQty + qty);
        const newAvg = newQty === 0 ? 0 : round6(((oldQty * oldAvg) + (qty * unitCost)) / newQty);

        await client.query(
          `UPDATE inventory_balances SET qty_on_hand=$4, avg_unit_cost=$5, updated_at=NOW() WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
          [orgId, txn.dest_warehouse_id, l.item_id, newQty, newAvg]
        );
        await client.query(
          `UPDATE inventory_transaction_lines SET extended_cost=$2 WHERE id=$1`,
          [l.id, ext]
        );
        if (method === "FIFO") {
          await repo.createFifoLayer(client, orgId, txn.dest_warehouse_id, l.item_id, l.id, qty, unitCost);
        }

        const acc = itemMap.get(l.item_id);
        journalLines.push({ accountId: acc.inventory_account_id, debit: ext, credit: 0, memo: "Inventory receipt" });
        journalLines.push({ accountId: acc.clearing_account_id, debit: 0, credit: ext, memo: "Inventory receipt" });
      }
    } else if (txnType === "issue") {
      if (!txn.source_warehouse_id) throw new AppError(400, "sourceWarehouseId is required for issue");
      for (const l of lineRows) {
        const bal = await getBal(txn.source_warehouse_id, l.item_id);
        const qty = Number(l.quantity);
        const onHand = Number(bal.qty_on_hand);
        if (onHand < qty) throw new AppError(409, `Insufficient stock for item ${l.item_id}`);

        let unitCost = Number(bal.avg_unit_cost);
        let ext = round6(qty * unitCost);
        if (method === "FIFO") {
          const r = await repo.consumeFifoLayers(client, orgId, txn.source_warehouse_id, l.item_id, l.id, qty);
          if (!r.ok) throw new AppError(409, `Insufficient FIFO layers for item ${l.item_id}`);
          ext = round6(r.consumptions.reduce((s, c) => s + Number(c.quantity) * Number(c.unitCost), 0));
          unitCost = round6(ext / qty);
        }

        await client.query(
          `UPDATE inventory_transaction_lines SET unit_cost=$2, extended_cost=$3 WHERE id=$1`,
          [l.id, unitCost, ext]
        );
        await client.query(
          `UPDATE inventory_balances SET qty_on_hand=$4, updated_at=NOW() WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
          [orgId, txn.source_warehouse_id, l.item_id, round6(onHand - qty)]
        );

        const acc = itemMap.get(l.item_id);
        journalLines.push({ accountId: acc.cogs_account_id, debit: ext, credit: 0, memo: "Inventory issue" });
        journalLines.push({ accountId: acc.inventory_account_id, debit: 0, credit: ext, memo: "Inventory issue" });
      }
    } else if (txnType === "transfer") {
      if (!txn.source_warehouse_id || !txn.dest_warehouse_id) throw new AppError(400, "sourceWarehouseId and destWarehouseId are required for transfer");
      if (txn.source_warehouse_id === txn.dest_warehouse_id) throw new AppError(400, "sourceWarehouseId cannot equal destWarehouseId");
      for (const l of lineRows) {
        const srcBal = await getBal(txn.source_warehouse_id, l.item_id);
        const qty = Number(l.quantity);
        const onHand = Number(srcBal.qty_on_hand);
        if (onHand < qty) throw new AppError(409, `Insufficient stock for item ${l.item_id}`);

        let unitCost = Number(srcBal.avg_unit_cost);
        let ext = round6(qty * unitCost);
        if (method === "FIFO") {
          const r = await repo.consumeFifoLayers(client, orgId, txn.source_warehouse_id, l.item_id, l.id, qty);
          if (!r.ok) throw new AppError(409, `Insufficient FIFO layers for item ${l.item_id}`);
          ext = round6(r.consumptions.reduce((s, c) => s + Number(c.quantity) * Number(c.unitCost), 0));
          unitCost = round6(ext / qty);
          await repo.createFifoLayer(client, orgId, txn.dest_warehouse_id, l.item_id, l.id, qty, unitCost);
        }

        await client.query(
          `UPDATE inventory_transaction_lines SET unit_cost=$2, extended_cost=$3 WHERE id=$1`,
          [l.id, unitCost, ext]
        );

        await client.query(
          `UPDATE inventory_balances SET qty_on_hand=$4, updated_at=NOW() WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
          [orgId, txn.source_warehouse_id, l.item_id, round6(onHand - qty)]
        );

        const dstBal = await getBal(txn.dest_warehouse_id, l.item_id);
        const dstQty = Number(dstBal.qty_on_hand);
        const dstAvg = Number(dstBal.avg_unit_cost);
        const newDstQty = round6(dstQty + qty);
        const newDstAvg = newDstQty === 0 ? 0 : round6(((dstQty * dstAvg) + (qty * unitCost)) / newDstQty);
        await client.query(
          `UPDATE inventory_balances SET qty_on_hand=$4, avg_unit_cost=$5, updated_at=NOW() WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
          [orgId, txn.dest_warehouse_id, l.item_id, newDstQty, newDstAvg]
        );
      }
    } else if (txnType === "adjustment") {
      if (!txn.source_warehouse_id) throw new AppError(400, "sourceWarehouseId is required for adjustment");
      for (const l of lineRows) {
        const dir = l.direction;
        if (dir !== "increase" && dir !== "decrease") throw new AppError(400, "direction is required for adjustment lines");
        const bal = await getBal(txn.source_warehouse_id, l.item_id);
        const qty = Number(l.quantity);
        const acc = itemMap.get(l.item_id);

        if (dir === "increase") {
          const unitCost = Number(l.unit_cost ?? bal.avg_unit_cost ?? 0);
          const ext = round6(qty * unitCost);
          const oldQty = Number(bal.qty_on_hand);
          const oldAvg = Number(bal.avg_unit_cost);
          const newQty = round6(oldQty + qty);
          const newAvg = method === "WEIGHTED_AVERAGE" ? (newQty === 0 ? 0 : round6(((oldQty * oldAvg) + (qty * unitCost)) / newQty)) : oldAvg;
          await client.query(
            `UPDATE inventory_balances SET qty_on_hand=$4, avg_unit_cost=$5, updated_at=NOW() WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
            [orgId, txn.source_warehouse_id, l.item_id, newQty, newAvg]
          );
          await client.query(`UPDATE inventory_transaction_lines SET unit_cost=$2, extended_cost=$3 WHERE id=$1`, [l.id, unitCost, ext]);
          if (method === "FIFO") await repo.createFifoLayer(client, orgId, txn.source_warehouse_id, l.item_id, l.id, qty, unitCost);
          journalLines.push({ accountId: acc.inventory_account_id, debit: ext, credit: 0, memo: "Inventory adjustment increase" });
          journalLines.push({ accountId: acc.adjustment_account_id, debit: 0, credit: ext, memo: "Inventory adjustment increase" });
        } else {
          const onHand = Number(bal.qty_on_hand);
          if (onHand < qty) throw new AppError(409, `Insufficient stock for item ${l.item_id}`);
          let unitCost = Number(bal.avg_unit_cost);
          let ext = round6(qty * unitCost);
          if (method === "FIFO") {
            const r = await repo.consumeFifoLayers(client, orgId, txn.source_warehouse_id, l.item_id, l.id, qty);
            if (!r.ok) throw new AppError(409, `Insufficient FIFO layers for item ${l.item_id}`);
            ext = round6(r.consumptions.reduce((s, c) => s + Number(c.quantity) * Number(c.unitCost), 0));
            unitCost = round6(ext / qty);
          }
          await client.query(`UPDATE inventory_transaction_lines SET unit_cost=$2, extended_cost=$3 WHERE id=$1`, [l.id, unitCost, ext]);
          await client.query(
            `UPDATE inventory_balances SET qty_on_hand=$4, updated_at=NOW() WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
            [orgId, txn.source_warehouse_id, l.item_id, round6(onHand - qty)]
          );
          journalLines.push({ accountId: acc.adjustment_account_id, debit: ext, credit: 0, memo: "Inventory adjustment decrease" });
          journalLines.push({ accountId: acc.inventory_account_id, debit: 0, credit: ext, memo: "Inventory adjustment decrease" });
        }
      }
    } else {
      throw new AppError(400, `Unsupported txnType: ${txnType}`);
    }

    let postedJournalId = null;
    if (journalLines.length) {
      const agg = aggregateJournalLines(journalLines);
      const debit = round6(agg.reduce((s, l) => s + Number(l.debit || 0), 0));
      const credit = round6(agg.reduce((s, l) => s + Number(l.credit || 0), 0));
      if (debit !== credit) throw new AppError(500, "Inventory journal not balanced");

      const draft = await createDraftJournal({
        orgId,
        actorUserId,
        payload: {
          periodId: txn.period_id,
          entryDate: txn.txn_date,
          typeCode: "GENERAL",
          memo: txn.memo || `Inventory ${txn.txn_type}`,
          idempotencyKey: `inv-txn:${orgId}:${txn.id}`,
          lines: agg.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.memo || null })),
        },
      });
      const posted = await postDraftJournal({ orgId, journalId: draft.journalId, actorUserId });
      postedJournalId = posted.journalId;
      await repo.linkJournal(client, txn.id, postedJournalId);
    }

    await client.query(
      `UPDATE inventory_transactions SET status2='posted', status='posted' WHERE organization_id=$1 AND id=$2`,
      [orgId, txn.id]
    );

    await client.query("COMMIT");
    return { transactionId: txn.id, status2: "posted", journalEntryId: postedJournalId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function reversePostedTransaction({ orgId, actorUserId, transactionId, reason }) {
  const orig = await repo.getTransactionWithLines(orgId, transactionId);
  if (!orig) throw new AppError(404, "Transaction not found");
  if (orig.txn.status2 !== "posted") throw new AppError(409, "Only posted transactions can be reversed");
  if (orig.txn.reversed_txn_id) return { transactionId, reversedTxnId: orig.txn.reversed_txn_id };

  const reverseType = orig.txn.txn_type === "transfer" ? "transfer" : "adjustment";

  const draftPayload = {
    periodId: orig.txn.period_id,
    txnDate: orig.txn.txn_date,
    txnType: reverseType,
    sourceWarehouseId: orig.txn.source_warehouse_id,
    destWarehouseId: orig.txn.dest_warehouse_id,
    reference: `REV:${orig.txn.id}`,
    memo: reason ? `Reversal: ${reason}` : `Reversal of ${orig.txn.id}`,
    lines: orig.lines.map((l) => {
      const q = Number(l.quantity);
      if (orig.txn.txn_type === "receipt") return { itemId: l.item_id, quantity: q, direction: "decrease" };
      if (orig.txn.txn_type === "issue") return { itemId: l.item_id, quantity: q, direction: "increase", unitCost: Number(l.unit_cost || 0) };
      if (orig.txn.txn_type === "transfer") return { itemId: l.item_id, quantity: q };
      const dir = l.direction === "increase" ? "decrease" : "increase";
      return { itemId: l.item_id, quantity: q, direction: dir, unitCost: Number(l.unit_cost || 0) };
    }),
  };

  const created = await createDraftTransaction({ orgId, actorUserId, payload: draftPayload });
  const createdId = created.transactionId;

  await submitTransactionForApproval({ orgId, actorUserId, transactionId: createdId });
  await approveTransactionWorkflow({ orgId, actorUserId, transactionId: createdId, comment: reason ? `Auto-approved reversal: ${reason}` : "Auto-approved reversal" });
  const posted = await postApprovedTransaction({ orgId, actorUserId, transactionId: createdId });

  await pool.query(
    `UPDATE inventory_transactions SET reversed_txn_id=$3 WHERE organization_id=$1 AND id=$2`,
    [orgId, transactionId, posted.transactionId]
  );

  return { transactionId, reversedTxnId: posted.transactionId };
}

module.exports = {
  ensureCostMethod,
  createDraftTransaction,
  listTransactions,
  getTransaction,
  submitTransactionForApproval,
  approveTransactionWorkflow,
  rejectTransactionWorkflow,
  assertTransactionApprovalStateAllowsPost,
  approveTransaction,
  postApprovedTransaction,
  voidTransaction,
  reversePostedTransaction,
};
