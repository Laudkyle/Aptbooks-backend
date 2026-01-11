const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const repo = require("./transactions.repository");
const { getSetting, upsertSetting } = require("../inventory.settings.repository");
const { createDraftJournal, postDraftJournal } = require("../../../interfaces/journalPosting.interface");

function round6(n) { return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6; }

async function ensureCostMethod(orgId) {
  const current = await getSetting(orgId, "inventoryCostMethod");
  if (!current) {
    await upsertSetting(orgId, "inventoryCostMethod", { method: "WEIGHTED_AVERAGE", locked: false });
    return { method: "WEIGHTED_AVERAGE", locked: false };
  }
  return current;
}

async function assertPeriodOpen(client, orgId, periodId, date) {
  const { rows } = await client.query(
    `SELECT id, status, start_date, end_date
     FROM accounting_periods
     WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  
  if (!rows.length) throw new AppError(404, "Accounting period not found");
  const p = rows[0];
  
  if (p.status !== "open") throw new AppError(409, "Period not open");

  // Ensure date is a Date object
  const dd = date instanceof Date ? date : new Date(date);
  
  // Clone dates and strip time components
  const start = new Date(p.start_date);
  const end = new Date(p.end_date);
  
  // Set to start of day for start date
  start.setHours(0, 0, 0, 0);
  
  // Set to end of day for end date (23:59:59.999)
  end.setHours(23, 59, 59, 999);
  
  // Or if you want to include the entire end date:
  // end.setHours(23, 59, 59, 999);
  if (dd < start || dd > end) {
    throw new AppError(409, "Transaction date outside open period");
  }
  
  return p;
}

function aggregateJournalLines(lines) {
  const map = new Map();
  for (const l of lines) {
    const key = l.accountId;
    const prev = map.get(key) || { accountId: key, debit: 0, credit: 0, memo: l.memo };
    prev.debit += Number(l.debit || 0);
    prev.credit += Number(l.credit || 0);
    map.set(key, prev);
  }
  return Array.from(map.values()).map(x => ({ ...x, debit: round6(x.debit), credit: round6(x.credit) }));
}

async function lockCostMethodIfAccountingStarted(client, orgId) {
  const { rows: j } = await client.query(
    `SELECT 1 FROM journal_entries WHERE organization_id=$1 AND status='posted' LIMIT 1`,
    [orgId]
  );
  if (!j.length) return;
  const current = await getSetting(orgId, "inventoryCostMethod");
  if (current && current.locked) return;
  await upsertSetting(orgId, "inventoryCostMethod", { method: (current?.method || "WEIGHTED_AVERAGE"), locked: true });
}

async function postInventoryTransaction({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await repo.findTransactionByIdempotency(client, orgId, payload.idempotencyKey);
    if (existing) {
      await client.query("COMMIT");
      return { transactionId: existing.id, status: existing.status, journalEntryId: existing.journal_entry_id, idempotent: true };
    }

    const { method } = await ensureCostMethod(orgId);

    if (!payload?.periodId || !payload?.txnDate || !payload?.txnType) throw new AppError(400, "periodId, txnDate, txnType are required");
    await assertPeriodOpen(client, orgId, payload.periodId, payload.txnDate);

    const txnType = payload.txnType;
    const lines = payload.lines || [];
    if (!Array.isArray(lines) || !lines.length) throw new AppError(400, "lines[] is required");

    const itemIds = lines.map(l => l.itemId);
    const items = await repo.getItemsWithAccounts(orgId, itemIds);
    const itemMap = new Map(items.map(r => [r.item_id, r]));
    for (const l of lines) {
      if (!l.itemId || l.quantity == null) throw new AppError(400, "Each line requires itemId and quantity");
      if (!itemMap.has(l.itemId)) throw new AppError(400, `Unknown itemId ${l.itemId}`);
      if (Number(l.quantity) <= 0) throw new AppError(400, "quantity must be > 0");
    }

    const txn = await repo.insertTransaction(client, orgId, {
      periodId: payload.periodId,
      txnDate: payload.txnDate,
      txnType,
      sourceWarehouseId: payload.sourceWarehouseId || null,
      destWarehouseId: payload.destWarehouseId || null,
      reference: payload.reference,
      memo: payload.memo,
      idempotencyKey: payload.idempotencyKey,
      createdBy: actorUserId
    });

    const journalLines = [];
    const getBal = (warehouseId, itemId) => repo.getBalanceForUpdate(client, orgId, warehouseId, itemId);

    if (txnType === "receipt") {
      if (!payload.destWarehouseId) throw new AppError(400, "destWarehouseId is required for receipt");
      for (const l of lines) {
        if (l.unitCost == null) throw new AppError(400, "unitCost is required for receipt lines");
        const bal = await getBal(payload.destWarehouseId, l.itemId);

        const qty = Number(l.quantity);
        const unitCost = Number(l.unitCost);
        const ext = round6(qty * unitCost);

        const oldQty = Number(bal.qty_on_hand);
        const oldAvg = Number(bal.avg_unit_cost);
        const newQty = round6(oldQty + qty);
        const newAvg = (newQty === 0 ? 0 : round6(((oldQty * oldAvg) + (qty * unitCost)) / newQty));

        await client.query(
          `UPDATE inventory_balances SET qty_on_hand=$4, avg_unit_cost=$5, updated_at=now()
           WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
          [orgId, payload.destWarehouseId, l.itemId, newQty, newAvg]
        );

        const inserted = await repo.insertTxnLine(client, txn.id, { itemId: l.itemId, quantity: qty, unitCost, extendedCost: ext });

        if (method === "FIFO") {
          await repo.createFifoLayer(client, orgId, payload.destWarehouseId, l.itemId, inserted.id, qty, unitCost);
        }

        const acc = itemMap.get(l.itemId);
        journalLines.push({ accountId: acc.inventory_account_id, debit: ext, credit: 0, memo: "Inventory receipt" });
        journalLines.push({ accountId: acc.clearing_account_id, debit: 0, credit: ext, memo: "Inventory receipt" });
      }
    } else if (txnType === "issue") {
      if (!payload.sourceWarehouseId) throw new AppError(400, "sourceWarehouseId is required for issue");
      for (const l of lines) {
        const bal = await getBal(payload.sourceWarehouseId, l.itemId);
        const qty = Number(l.quantity);
        const onHand = Number(bal.qty_on_hand);
        if (onHand < qty) throw new AppError(409, `Insufficient stock for item ${l.itemId}`);

        let unitCost = Number(bal.avg_unit_cost);
        let ext = round6(qty * unitCost);

        const inserted = await repo.insertTxnLine(client, txn.id, { itemId: l.itemId, quantity: qty, unitCost, extendedCost: ext });

        if (method === "FIFO") {
          const r = await repo.consumeFifoLayers(client, orgId, payload.sourceWarehouseId, l.itemId, inserted.id, qty);
          if (!r.ok) throw new AppError(409, `Insufficient FIFO layers for item ${l.itemId}`);
          ext = round6(r.consumptions.reduce((s,c)=> s + Number(c.quantity)*Number(c.unitCost), 0));
          unitCost = round6(ext / qty);
          await client.query(`UPDATE inventory_transaction_lines SET unit_cost=$2, extended_cost=$3 WHERE id=$1`, [inserted.id, unitCost, ext]);
        }

        await client.query(
          `UPDATE inventory_balances SET qty_on_hand=$4, updated_at=now()
           WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
          [orgId, payload.sourceWarehouseId, l.itemId, round6(onHand - qty)]
        );

        const acc = itemMap.get(l.itemId);
        journalLines.push({ accountId: acc.cogs_account_id, debit: ext, credit: 0, memo: "Inventory issue" });
        journalLines.push({ accountId: acc.inventory_account_id, debit: 0, credit: ext, memo: "Inventory issue" });
      }
    } else if (txnType === "transfer") {
      if (!payload.sourceWarehouseId || !payload.destWarehouseId) throw new AppError(400, "sourceWarehouseId and destWarehouseId are required for transfer");
      if (payload.sourceWarehouseId === payload.destWarehouseId) throw new AppError(400, "sourceWarehouseId cannot equal destWarehouseId");

      for (const l of lines) {
        const srcBal = await getBal(payload.sourceWarehouseId, l.itemId);
        const qty = Number(l.quantity);
        const onHand = Number(srcBal.qty_on_hand);
        if (onHand < qty) throw new AppError(409, `Insufficient stock for item ${l.itemId}`);

        let unitCost = Number(srcBal.avg_unit_cost);
        let ext = round6(qty * unitCost);

        const inserted = await repo.insertTxnLine(client, txn.id, { itemId: l.itemId, quantity: qty, unitCost, extendedCost: ext });

        if (method === "FIFO") {
          const r = await repo.consumeFifoLayers(client, orgId, payload.sourceWarehouseId, l.itemId, inserted.id, qty);
          if (!r.ok) throw new AppError(409, `Insufficient FIFO layers for item ${l.itemId}`);
          ext = round6(r.consumptions.reduce((s,c)=> s + Number(c.quantity)*Number(c.unitCost), 0));
          unitCost = round6(ext / qty);
          await client.query(`UPDATE inventory_transaction_lines SET unit_cost=$2, extended_cost=$3 WHERE id=$1`, [inserted.id, unitCost, ext]);
          await repo.createFifoLayer(client, orgId, payload.destWarehouseId, l.itemId, inserted.id, qty, unitCost);
        }

        await client.query(
          `UPDATE inventory_balances SET qty_on_hand=$4, updated_at=now()
           WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
          [orgId, payload.sourceWarehouseId, l.itemId, round6(onHand - qty)]
        );

        const dstBal = await getBal(payload.destWarehouseId, l.itemId);
        const dstQty = Number(dstBal.qty_on_hand);
        const dstAvg = Number(dstBal.avg_unit_cost);
        const newDstQty = round6(dstQty + qty);
        const newDstAvg = (newDstQty === 0 ? 0 : round6(((dstQty * dstAvg) + (qty * unitCost)) / newDstQty));

        await client.query(
          `UPDATE inventory_balances SET qty_on_hand=$4, avg_unit_cost=$5, updated_at=now()
           WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
          [orgId, payload.destWarehouseId, l.itemId, newDstQty, newDstAvg]
        );
      }
      // no journal
    } else if (txnType === "adjustment") {
      if (!payload.sourceWarehouseId) throw new AppError(400, "sourceWarehouseId (warehouseId) is required for adjustment");

      for (const l of lines) {
        if (l.direction !== "increase" && l.direction !== "decrease") throw new AppError(400, "direction must be 'increase' or 'decrease'");
        const bal = await getBal(payload.sourceWarehouseId, l.itemId);
        const qty = Number(l.quantity);
        const acc = itemMap.get(l.itemId);

        if (l.direction === "increase") {
          const unitCost = Number(l.unitCost ?? bal.avg_unit_cost ?? 0);
          const ext = round6(qty * unitCost);

          const oldQty = Number(bal.qty_on_hand);
          const oldAvg = Number(bal.avg_unit_cost);
          const newQty = round6(oldQty + qty);
          const newAvg = method === "WEIGHTED_AVERAGE"
            ? (newQty === 0 ? 0 : round6(((oldQty * oldAvg) + (qty * unitCost)) / newQty))
            : oldAvg;

          await client.query(
            `UPDATE inventory_balances SET qty_on_hand=$4, avg_unit_cost=$5, updated_at=now()
             WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
            [orgId, payload.sourceWarehouseId, l.itemId, newQty, newAvg]
          );

          const inserted = await repo.insertTxnLine(client, txn.id, { itemId: l.itemId, quantity: qty, unitCost, extendedCost: ext });
          if (method === "FIFO") await repo.createFifoLayer(client, orgId, payload.sourceWarehouseId, l.itemId, inserted.id, qty, unitCost);

          journalLines.push({ accountId: acc.inventory_account_id, debit: ext, credit: 0, memo: "Inventory adjustment increase" });
          journalLines.push({ accountId: acc.adjustment_account_id, debit: 0, credit: ext, memo: "Inventory adjustment increase" });
        } else {
          const onHand = Number(bal.qty_on_hand);
          if (onHand < qty) throw new AppError(409, `Insufficient stock for item ${l.itemId}`);

          let unitCost = Number(bal.avg_unit_cost);
          let ext = round6(qty * unitCost);

          const inserted = await repo.insertTxnLine(client, txn.id, { itemId: l.itemId, quantity: qty, unitCost, extendedCost: ext });

          if (method === "FIFO") {
            const r = await repo.consumeFifoLayers(client, orgId, payload.sourceWarehouseId, l.itemId, inserted.id, qty);
            if (!r.ok) throw new AppError(409, `Insufficient FIFO layers for item ${l.itemId}`);
            ext = round6(r.consumptions.reduce((s,c)=> s + Number(c.quantity)*Number(c.unitCost), 0));
            unitCost = round6(ext / qty);
            await client.query(`UPDATE inventory_transaction_lines SET unit_cost=$2, extended_cost=$3 WHERE id=$1`, [inserted.id, unitCost, ext]);
          }

          await client.query(
            `UPDATE inventory_balances SET qty_on_hand=$4, updated_at=now()
             WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
            [orgId, payload.sourceWarehouseId, l.itemId, round6(onHand - qty)]
          );

          journalLines.push({ accountId: acc.adjustment_account_id, debit: ext, credit: 0, memo: "Inventory adjustment decrease" });
          journalLines.push({ accountId: acc.inventory_account_id, debit: 0, credit: ext, memo: "Inventory adjustment decrease" });
        }
      }
    } else {
      throw new AppError(400, "Unsupported txnType");
    }

    let journalEntryId = null;
    if (journalLines.length) {
      const jPayload = {
        periodId: payload.periodId,
        entryDate: payload.txnDate,
        memo: payload.memo || `Inventory ${txnType}`,
        idempotencyKey: payload.idempotencyKey ? `inv-journal:${payload.idempotencyKey}` : null,
        lines: aggregateJournalLines(journalLines).map(l => ({
          accountId: l.accountId,
          debit: l.debit || 0,
          credit: l.credit || 0,
          memo: l.memo
        }))
      };
      const { journalId } = await createDraftJournal({ orgId, actorUserId, payload: jPayload });
      await postDraftJournal({ orgId, journalId, actorUserId });
      journalEntryId = journalId;
      await repo.linkJournal(client, txn.id, journalId);
    }

    await lockCostMethodIfAccountingStarted(client, orgId);

    await client.query("COMMIT");
    return { transactionId: txn.id, journalEntryId, costMethod: method };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { postInventoryTransaction, ensureCostMethod };
