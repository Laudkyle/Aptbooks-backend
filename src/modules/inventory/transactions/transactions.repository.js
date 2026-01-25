const { pool } = require("../../../db/pool");

async function getItemsWithAccounts(orgId, itemIds) {
  const { rows } = await pool.query(
    `SELECT i.id AS item_id, i.sku, i.name,
            c.id AS category_id,
            c.inventory_account_id, c.cogs_account_id, c.adjustment_account_id, c.clearing_account_id
     FROM inventory_items i
     JOIN item_categories c ON c.id=i.category_id
     WHERE i.organization_id=$1 AND i.id = ANY($2::uuid[])`,
    [orgId, itemIds]
  );
  return rows;
}

async function getBalanceForUpdate(client, orgId, warehouseId, itemId) {
  const { rows } = await client.query(
    `SELECT organization_id, warehouse_id, item_id, qty_on_hand, avg_unit_cost
     FROM inventory_balances
     WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3
     FOR UPDATE`,
    [orgId, warehouseId, itemId]
  );
  if (!rows.length) {
    const { rows: created } = await client.query(
      `INSERT INTO inventory_balances(organization_id, warehouse_id, item_id, qty_on_hand, avg_unit_cost)
       VALUES ($1,$2,$3,0,0)
       RETURNING organization_id, warehouse_id, item_id, qty_on_hand, avg_unit_cost`,
      [orgId, warehouseId, itemId]
    );
    return created[0];
  }
  return rows[0];
}

async function insertTransaction(client, orgId, payload) {
  const { periodId, txnDate, txnType, sourceWarehouseId, destWarehouseId, reference, memo, idempotencyKey, createdBy } = payload;
  const { rows } = await client.query(
    `INSERT INTO inventory_transactions(
        organization_id, period_id, txn_date, txn_type,
        source_warehouse_id, dest_warehouse_id,
        reference, memo, status, idempotency_key, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'posted',$9,$10)
     RETURNING *`,
    [orgId, periodId, txnDate, txnType, sourceWarehouseId, destWarehouseId, reference || null, memo || null, idempotencyKey || null, createdBy || null]
  );
  return rows[0];
}

async function insertDraftTransaction(client, orgId, payload) {
  const { periodId, txnDate, txnType, sourceWarehouseId, destWarehouseId, reference, memo, idempotencyKey, createdBy } = payload;
  const { rows } = await client.query(
    `INSERT INTO inventory_transactions(
        organization_id, period_id, txn_date, txn_type,
        source_warehouse_id, dest_warehouse_id,
        reference, memo, status, status2, idempotency_key, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'posted','draft',$9,$10)
     RETURNING *`,
    [orgId, periodId, txnDate, txnType, sourceWarehouseId, destWarehouseId, reference || null, memo || null, idempotencyKey || null, createdBy || null]
  );
  return rows[0];
}

async function findTransactionByIdempotency(client, orgId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const { rows } = await client.query(
    `SELECT id, status, journal_entry_id FROM inventory_transactions WHERE organization_id=$1 AND idempotency_key=$2`,
    [orgId, idempotencyKey]
  );
  return rows[0] || null;
}

async function insertTxnLine(client, txnId, line) {
  const { itemId, quantity, unitCost, extendedCost, direction } = line;
  const { rows } = await client.query(
    `INSERT INTO inventory_transaction_lines(transaction_id, item_id, quantity, unit_cost, extended_cost)
     VALUES($1,$2,$3,$4,$5)
     RETURNING *`,
    [txnId, itemId, quantity, unitCost, extendedCost]
  );
  if (direction) {
    await client.query(`UPDATE inventory_transaction_lines SET direction=$2 WHERE id=$1`, [rows[0].id, direction]);
  }
  return rows[0];
}

async function setStatus2(client, orgId, txnId, status2, actorUserId, reason) {
  const fields = [];
  const params = [orgId, txnId, status2];
  let i = 4;
  if (status2 === 'approved') {
    fields.push(`approved_by=$${i++}`, `approved_at=NOW()`);
    params.push(actorUserId || null);
  }
  if (status2 === 'voided') {
    fields.push(`voided_by=$${i++}`, `voided_at=NOW()`, `void_reason=$${i++}`);
    params.push(actorUserId || null, reason || null);
  }
  const { rows } = await client.query(
    `UPDATE inventory_transactions
     SET status2=$3${fields.length ? ',' + fields.join(',') : ''}
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function getTransactionWithLines(client, orgId, txnId) {
  const { rows: txRows } = await client.query(
    `SELECT * FROM inventory_transactions WHERE organization_id=$1 AND id=$2`,
    [orgId, txnId]
  );
  if (!txRows.length) return null;
  const { rows: lineRows } = await client.query(
    `SELECT * FROM inventory_transaction_lines WHERE transaction_id=$1 ORDER BY created_at ASC`,
    [txnId]
  );
  return { txn: txRows[0], lines: lineRows };
}

async function listTransactions(orgId, query = {}) {
  const params = [orgId];
  const where = ['organization_id=$1'];
  let i = 2;
  if (query.status2) { where.push(`status2=$${i++}`);params.push(query.status2);}
  if (query.txnType) { where.push(`txn_type=$${i++}`);params.push(query.txnType);}
  if (query.periodId) { where.push(`period_id=$${i++}`);params.push(query.periodId);}
  const { rows } = await pool.query(
    `SELECT * FROM inventory_transactions WHERE ${where.join(' AND ')} ORDER BY txn_date DESC, created_at DESC`,
    params
  );
  return rows;
}

async function linkJournal(client, txnId, journalId) {
  await client.query(
    `UPDATE inventory_transactions SET journal_entry_id=$2 WHERE id=$1`,
    [txnId, journalId]
  );
}

async function createFifoLayer(client, orgId, warehouseId, itemId, receivedTxnLineId, qty, unitCost) {
  const { rows } = await client.query(
    `INSERT INTO inventory_cost_layers(organization_id, warehouse_id, item_id, received_txn_line_id, qty_remaining, unit_cost)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [orgId, warehouseId, itemId, receivedTxnLineId, qty, unitCost]
  );
  return rows[0];
}

async function consumeFifoLayers(client, orgId, warehouseId, itemId, txnLineId, qtyNeeded) {
  const consumptions = [];
  let remaining = Number(qtyNeeded);
  while (remaining > 0) {
    const { rows: layers } = await client.query(
      `SELECT id, qty_remaining, unit_cost
       FROM inventory_cost_layers
       WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3 AND qty_remaining > 0
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE`,
      [orgId, warehouseId, itemId]
    );
    if (!layers.length) break;
    const layer = layers[0];
    const take = Math.min(remaining, Number(layer.qty_remaining));
    await client.query(`UPDATE inventory_cost_layers SET qty_remaining = qty_remaining - $2 WHERE id=$1`, [layer.id, take]);
    await client.query(
      `INSERT INTO inventory_layer_consumptions(txn_line_id, layer_id, quantity, unit_cost)
       VALUES($1,$2,$3,$4)`,
      [txnLineId, layer.id, take, layer.unit_cost]
    );
    consumptions.push({ layerId: layer.id, quantity: take, unitCost: Number(layer.unit_cost) });
    remaining -= take;
  }
  if (remaining > 0) return { ok: false, consumptions, remaining };
  return { ok: true, consumptions, remaining: 0 };
}

module.exports = {
  getItemsWithAccounts,
  getBalanceForUpdate,
  insertTransaction,
  insertDraftTransaction,
  findTransactionByIdempotency,
  insertTxnLine,
  linkJournal,
  createFifoLayer,
  consumeFifoLayers,
  setStatus2,
  getTransactionWithLines,
  listTransactions
};
