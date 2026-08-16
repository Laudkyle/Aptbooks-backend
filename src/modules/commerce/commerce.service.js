const Decimal = require('decimal.js');
const { pool } = require('../../db/pool');
const { AppError } = require('../../shared/errors/AppError');
const journalIF = require('../../interfaces/journalPosting.interface');
const periodIF = require('../../interfaces/periodManagement.interface');
const { syncPosTaxDetailToLedger, syncPosReturnTaxDetailToLedger } = require('../../shared/tax/taxLedger');
const { computeComponentTaxBreakdown } = require('../../shared/tax/taxMath');
const fiscalizationSvc = require('../integrations/fiscalization/fiscalization.service');

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });
const D = (v) => new Decimal(v == null || v === '' ? 0 : v);
const money = (v) => D(v).toDecimalPlaces(2).toFixed(2);
const qty = (v) => D(v).toDecimalPlaces(6).toFixed(6);
const uuidArray = (arr) => `{${arr.join(',')}}`;

function toCamelKey(key) { return String(key).replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
function toSnakeKey(key) { return String(key).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }
function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === 'object' && !(value instanceof Decimal) && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [toCamelKey(k), camelize(v)]));
  }
  return value;
}
function normalizePayload(value) {
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (value && typeof value === 'object' && !(value instanceof Decimal) && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[toCamelKey(k)] = normalizePayload(v);
    return out;
  }
  return value;
}
function cleanQuery(query = {}) {
  return normalizePayload(query || {});
}
function ok(result) { return camelize(result); }
function rowList(rows, meta = {}) { return ok({ data: rows || [], ...meta }); }
async function optionalQuery(sql, params = [], fallback = []) {
  try { const { rows } = await pool.query(sql, params); return rows; } catch (_) { return fallback; }
}
async function nextReturnNo(client) {
  const { rows } = await client.query(`SELECT nextval('pos_return_no_seq') AS n`);
  return `RET-${String(rows[0].n).padStart(8, '0')}`;
}


function ensureLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new AppError(400, 'At least one line is required');
}
function ensurePayments(payments) {
  if (!Array.isArray(payments) || !payments.length) throw new AppError(400, 'At least one payment is required');
}
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}
async function getOrgCurrency(client, orgId) {
  const { rows } = await client.query(`SELECT base_currency_code FROM organizations WHERE id=$1`, [orgId]);
  if (!rows.length) throw new AppError(400, 'Invalid organization');
  return rows[0].base_currency_code || 'GHS';
}
async function nextNo(client, orgId, table, prefix) {
  const { rows } = await client.query(`SELECT nextval($1) AS n`, [`${table}`]);
  return `${prefix}-${String(rows[0].n).padStart(8, '0')}`;
}
async function nextSaleNo(client, orgId) {
  const { rows } = await client.query(`SELECT nextval('pos_sale_no_seq') AS n`);
  return `POS-${String(rows[0].n).padStart(8, '0')}`;
}
async function nextOrderNo(client) {
  const { rows } = await client.query(`SELECT nextval('commerce_order_no_seq') AS n`);
  return `ORD-${String(rows[0].n).padStart(8, '0')}`;
}

async function listProducts({ orgId, query = {} }) {
  const params = [orgId];
  const where = [`i.organization_id=$1`, `COALESCE(i.is_active,true)=true`];
  let n = 2;
  if (query.q) { where.push(`(i.sku ILIKE $${n} OR i.name ILIKE $${n} OR COALESCE(i.barcode,'') ILIKE $${n})`); params.push(`%${query.q}%`); n++; }
  if (query.barcode) { where.push(`i.barcode=$${n++}`); params.push(query.barcode); }
  if (query.sku) { where.push(`i.sku=$${n++}`); params.push(query.sku); }
  const { rows } = await pool.query(
    `SELECT i.id, i.sku, i.name, i.barcode, i.status, i.is_active,
            c.code AS category_code, c.name AS category_name, u.code AS unit_code,
            COALESCE(SUM(b.qty_on_hand),0)::text AS qty_on_hand,
            CASE WHEN COUNT(b.item_id)>0 THEN AVG(b.avg_unit_cost)::text ELSE NULL END AS avg_unit_cost
       FROM inventory_items i
       LEFT JOIN item_categories c ON c.id=i.category_id
       LEFT JOIN item_units u ON u.id=i.unit_id
       LEFT JOIN inventory_balances b ON b.organization_id=i.organization_id AND b.item_id=i.id
      WHERE ${where.join(' AND ')}
      GROUP BY i.id, c.code, c.name, u.code
      ORDER BY i.sku
      LIMIT 100`, params);
  return { data: rows };
}
async function getProduct({ orgId, itemId }) {
  const { rows } = await pool.query(
    `SELECT i.*, c.code AS category_code, c.name AS category_name, u.code AS unit_code
       FROM inventory_items i
       LEFT JOIN item_categories c ON c.id=i.category_id
       LEFT JOIN item_units u ON u.id=i.unit_id
      WHERE i.organization_id=$1 AND i.id=$2`, [orgId, itemId]);
  if (!rows.length) throw new AppError(404, 'Product not found');
  return rows[0];
}
async function listCustomers({ orgId, query = {} }) {
  const params = [orgId];
  const where = [`organization_id=$1`, `type='customer'`];
  let n = 2;
  if (query.q) { where.push(`(name ILIKE $${n} OR COALESCE(code,'') ILIKE $${n} OR COALESCE(phone,'') ILIKE $${n} OR COALESCE(email::text,'') ILIKE $${n})`); params.push(`%${query.q}%`); n++; }
  if (query.status) { where.push(`status=$${n++}`); params.push(query.status); }
  const { rows } = await pool.query(`SELECT id, code, name, email, phone, status, default_receivable_account_id FROM business_partners WHERE ${where.join(' AND ')} ORDER BY name LIMIT 100`, params);
  return { data: rows };
}
async function customerPurchaseHistory({ orgId, customerId }) {
  const { rows } = await pool.query(
    `SELECT id, sale_no, sale_date, status, total_amount, paid_amount, balance_amount
       FROM pos_sales WHERE organization_id=$1 AND customer_id=$2 ORDER BY sale_date DESC, created_at DESC LIMIT 100`, [orgId, customerId]);
  return { data: rows };
}
async function listPriceLists({ orgId }) {
  const { rows } = await pool.query(`SELECT * FROM commerce_price_lists WHERE organization_id=$1 ORDER BY is_default DESC, name`, [orgId]);
  return { data: rows };
}
async function createPriceList({ orgId, actorUserId, payload }) {
  if (!payload?.code || !payload?.name) throw new AppError(400, 'code and name are required');
  const { rows } = await pool.query(
    `INSERT INTO commerce_price_lists(organization_id, code, name, currency_code, is_default, status, created_by)
     VALUES($1,$2,$3,$4,$5,'active',$6)
     ON CONFLICT (organization_id, code) DO UPDATE SET name=EXCLUDED.name, currency_code=EXCLUDED.currency_code, is_default=EXCLUDED.is_default, updated_at=now()
     RETURNING *`, [orgId, payload.code, payload.name, payload.currencyCode || payload.currency_code || 'GHS', !!payload.isDefault, actorUserId || null]);
  return rows[0];
}
async function upsertPriceListItem({ orgId, priceListId, payload }) {
  if (!payload?.itemId || payload.price == null) throw new AppError(400, 'itemId and price are required');
  const { rows } = await pool.query(
    `INSERT INTO commerce_price_list_items(organization_id, price_list_id, item_id, unit_price, effective_from, effective_to, status)
     VALUES($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE),$6,'active')
     ON CONFLICT (organization_id, price_list_id, item_id, effective_from) DO UPDATE SET unit_price=EXCLUDED.unit_price, effective_to=EXCLUDED.effective_to, status='active', updated_at=now()
     RETURNING *`, [orgId, priceListId, payload.itemId, money(payload.price), payload.effectiveFrom || null, payload.effectiveTo || null]);
  return rows[0];
}

async function listStores({ orgId }) {
  const { rows } = await pool.query(`SELECT s.*, w.code AS warehouse_code, w.name AS warehouse_name FROM pos_stores s LEFT JOIN warehouses w ON w.id=s.warehouse_id WHERE s.organization_id=$1 ORDER BY s.code`, [orgId]);
  return { data: rows };
}
async function createStore({ orgId, payload }) {
  if (!payload?.code || !payload?.name || !payload?.warehouseId) throw new AppError(400, 'code, name and warehouseId are required');
  const { rows } = await pool.query(
    `INSERT INTO pos_stores(organization_id, code, name, warehouse_id, address_json, status)
     VALUES($1,$2,$3,$4,$5,'active')
     ON CONFLICT (organization_id, code) DO UPDATE SET name=EXCLUDED.name, warehouse_id=EXCLUDED.warehouse_id, address_json=EXCLUDED.address_json, status='active', updated_at=now()
     RETURNING *`, [orgId, payload.code, payload.name, payload.warehouseId, payload.address || {}]);
  return rows[0];
}
async function updateStore({ orgId, storeId, payload }) {
  const { rows } = await pool.query(
    `UPDATE pos_stores SET name=COALESCE($3,name), warehouse_id=COALESCE($4,warehouse_id), address_json=COALESCE($5,address_json), status=COALESCE($6,status), updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, storeId, payload.name ?? null, payload.warehouseId ?? null, payload.address ?? null, payload.status ?? null]);
  if (!rows.length) throw new AppError(404, 'Store not found');
  return rows[0];
}
async function listRegisters({ orgId, query = {} }) {
  const params = [orgId];
  let where = `r.organization_id=$1`;
  if (query.storeId) { params.push(query.storeId); where += ` AND r.store_id=$2`; }
  const { rows } = await pool.query(`SELECT r.*, s.code AS store_code, s.name AS store_name FROM pos_registers r JOIN pos_stores s ON s.id=r.store_id WHERE ${where} ORDER BY s.code, r.code`, params);
  return { data: rows };
}
async function createRegister({ orgId, payload }) {
  if (!payload?.storeId || !payload?.code || !payload?.name) throw new AppError(400, 'storeId, code and name are required');
  const { rows } = await pool.query(
    `INSERT INTO pos_registers(organization_id, store_id, code, name, device_label, status)
     VALUES($1,$2,$3,$4,$5,'active')
     ON CONFLICT (organization_id, store_id, code) DO UPDATE SET name=EXCLUDED.name, device_label=EXCLUDED.device_label, status='active', updated_at=now()
     RETURNING *`, [orgId, payload.storeId, payload.code, payload.name, payload.deviceLabel || null]);
  return rows[0];
}
async function updateRegister({ orgId, registerId, payload }) {
  const { rows } = await pool.query(
    `UPDATE pos_registers SET name=COALESCE($3,name), device_label=COALESCE($4,device_label), status=COALESCE($5,status), updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, registerId, payload.name ?? null, payload.deviceLabel ?? null, payload.status ?? null]);
  if (!rows.length) throw new AppError(404, 'Register not found');
  return rows[0];
}
async function openShift({ orgId, actorUserId, payload }) {
  if (!payload?.registerId) throw new AppError(400, 'registerId is required');
  return withTx(async (client) => {
    const { rows: regRows } = await client.query(`SELECT r.*, s.warehouse_id FROM pos_registers r JOIN pos_stores s ON s.id=r.store_id WHERE r.organization_id=$1 AND r.id=$2 FOR UPDATE`, [orgId, payload.registerId]);
    if (!regRows.length) throw new AppError(404, 'Register not found');
    const open = await client.query(`SELECT id FROM pos_shifts WHERE organization_id=$1 AND register_id=$2 AND status='open' LIMIT 1`, [orgId, payload.registerId]);
    if (open.rows.length) throw new AppError(409, 'Register already has an open shift');
    const { rows } = await client.query(
      `INSERT INTO pos_shifts(organization_id, store_id, register_id, opened_by, opening_cash_amount, status)
       VALUES($1,$2,$3,$4,$5,'open') RETURNING *`, [orgId, regRows[0].store_id, payload.registerId, actorUserId || null, money(payload.openingCashAmount || 0)]);
    return rows[0];
  });
}
async function closeShift({ orgId, actorUserId, shiftId, payload }) {
  return withTx(async (client) => {
    const { rows: sRows } = await client.query(`SELECT * FROM pos_shifts WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, shiftId]);
    if (!sRows.length) throw new AppError(404, 'Shift not found');
    if (sRows[0].status !== 'open') throw new AppError(409, 'Only open shifts can be closed');
    const summary = await shiftSummary({ orgId, shiftId, client });
    const closing = D(payload?.closingCashAmount || 0);
    const expectedCash = D(sRows[0].opening_cash_amount).plus(D(summary.cashSales || 0)).plus(D(summary.cashIn || 0)).minus(D(summary.cashOut || 0));
    const variance = closing.minus(expectedCash);
    const { rows } = await client.query(
      `UPDATE pos_shifts SET status='closed', closed_at=now(), closed_by=$3, closing_cash_amount=$4, expected_cash_amount=$5, cash_variance_amount=$6, closing_notes=$7, updated_at=now()
       WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, shiftId, actorUserId || null, money(closing), money(expectedCash), money(variance), payload?.notes || null]);
    return { shift: rows[0], summary: { ...summary, expectedCash: money(expectedCash), variance: money(variance) } };
  });
}
async function recordCashMovement({ orgId, actorUserId, payload }) {
  if (!payload?.shiftId || !payload?.movementType || payload.amount == null) throw new AppError(400, 'shiftId, movementType and amount are required');
  const { rows } = await pool.query(
    `INSERT INTO pos_cash_movements(organization_id, shift_id, movement_type, amount, reason, reference, created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [orgId, payload.shiftId, payload.movementType, money(payload.amount), payload.reason || null, payload.reference || null, actorUserId || null]);
  return rows[0];
}
async function shiftSummary({ orgId, shiftId, client = null }) {
  const db = client || pool;
  const { rows: saleRows } = await db.query(
    `SELECT COALESCE(SUM(total_amount),0)::text total_sales, COALESCE(SUM(paid_amount),0)::text total_paid, COUNT(*)::int sale_count FROM pos_sales WHERE organization_id=$1 AND shift_id=$2 AND status NOT IN ('voided')`, [orgId, shiftId]);
  const { rows: payRows } = await db.query(
    `SELECT pm.code AS payment_method_code, pm.name AS payment_method_name, COALESCE(SUM(p.amount),0)::text amount, COUNT(*)::int count
       FROM pos_sale_payments p JOIN payment_methods pm ON pm.id=p.payment_method_id
      WHERE p.organization_id=$1 AND p.shift_id=$2 AND p.status='captured'
      GROUP BY pm.code, pm.name ORDER BY pm.code`, [orgId, shiftId]);
  const { rows: cashRows } = await db.query(
    `SELECT movement_type, COALESCE(SUM(amount),0)::text amount FROM pos_cash_movements WHERE organization_id=$1 AND shift_id=$2 GROUP BY movement_type`, [orgId, shiftId]);
  const cashSales = payRows.filter(r => String(r.payment_method_code).toUpperCase()==='CASH').reduce((a,r)=>a.plus(D(r.amount)), D(0));
  const cashIn = cashRows.filter(r => r.movement_type==='cash_in').reduce((a,r)=>a.plus(D(r.amount)), D(0));
  const cashOut = cashRows.filter(r => r.movement_type==='cash_out' || r.movement_type==='safe_drop').reduce((a,r)=>a.plus(D(r.amount)), D(0));
  return { ...saleRows[0], payments: payRows, cashMovements: cashRows, cashSales: money(cashSales), cashIn: money(cashIn), cashOut: money(cashOut) };
}

async function getTaxComponents(client, orgId, taxCodeId) {
  if (!taxCodeId) return [];
  const { rows: comps } = await client.query(
    `SELECT c.component_tax_code_id AS id, COALESCE(c.rate_override, tc.rate) AS rate, tc.code, tc.name, tc.tax_type, tc.box_code, tc.reporting_group, tc.tax_scope, tc.direction, tc.category_code, tc.reverse_charge
       FROM tax_code_components c JOIN tax_codes tc ON tc.id=c.component_tax_code_id
      WHERE c.organization_id=$1 AND c.parent_tax_code_id=$2 ORDER BY c.sequence_no`, [orgId, taxCodeId]);
  if (comps.length) return comps;
  const { rows } = await client.query(`SELECT id, rate, code, name, tax_type, box_code, reporting_group, tax_scope, direction, category_code, reverse_charge FROM tax_codes WHERE organization_id=$1 AND id=$2`, [orgId, taxCodeId]);
  return rows;
}
async function getLineInputs(client, orgId, lines) {
  ensureLines(lines);
  const itemIds = [...new Set(lines.map(l => l.itemId).filter(Boolean))];
  if (itemIds.length !== lines.length) throw new AppError(400, 'Every line requires itemId');
  const { rows } = await client.query(
    `SELECT i.id, i.sku, i.name, i.category_id, i.tax_profile_id,
            c.inventory_account_id, c.cogs_account_id,
            tcp.code AS tax_profile_code, tcp.supply_type AS tax_profile_supply_type,
            tcp.tax_category AS tax_profile_category,
            tcp.sales_tax_scope, tcp.sales_tax_code_id,
            tcp.exemption_reason_code, tcp.fiscal_classification_code, tcp.hs_code
       FROM inventory_items i
       JOIN item_categories c ON c.id=i.category_id
       LEFT JOIN tax_catalog_profiles tcp ON tcp.id=i.tax_profile_id AND tcp.organization_id=i.organization_id
         AND tcp.status='active' AND tcp.effective_from <= CURRENT_DATE
         AND (tcp.effective_to IS NULL OR tcp.effective_to >= CURRENT_DATE)
      WHERE i.organization_id=$1 AND i.id = ANY($2::uuid[])`, [orgId, itemIds]);
  if (rows.length !== itemIds.length) throw new AppError(400, 'One or more products were not found');
  return new Map(rows.map(r => [r.id, r]));
}
async function calculateSale(client, orgId, payload) {
  const items = await getLineInputs(client, orgId, payload.lines);
  let subtotal = D(0), discount = D(0), tax = D(0), total = D(0);
  const lineOut = [];
  for (const [idx, l] of payload.lines.entries()) {
    const quantity = D(l.quantity);
    if (quantity.lte(0)) throw new AppError(400, 'Line quantity must be greater than zero');
    const unitPrice = D(l.unitPrice);
    if (unitPrice.lt(0)) throw new AppError(400, 'Line unitPrice cannot be negative');
    const lineGrossBeforeDiscount = quantity.mul(unitPrice);
    const lineDiscount = D(l.discountAmount || 0);
    if (lineDiscount.lt(0) || lineDiscount.gt(lineGrossBeforeDiscount)) throw new AppError(400, 'Invalid line discount');
    const priceAfterDiscount = lineGrossBeforeDiscount.minus(lineDiscount);
    const effectiveTaxCodeId = l.taxCodeId || payload.taxCodeId || items.get(l.itemId)?.sales_tax_code_id || null;
    const components = await getTaxComponents(client, orgId, effectiveTaxCodeId);
    const breakdown = computeComponentTaxBreakdown({
      amount: money(priceAfterDiscount),
      components,
      inclusive: payload.taxInclusive === true,
    });
    const taxable = D(breakdown.taxableAmount);
    const lineTax = D(breakdown.taxAmount);
    const lineTotal = D(breakdown.totalAmount);
    const calculatedComponents = breakdown.components;
    subtotal = subtotal.plus(taxable);
    discount = discount.plus(lineDiscount);
    tax = tax.plus(lineTax);
    total = total.plus(lineTotal);
    lineOut.push({
      lineNo: idx + 1, item: items.get(l.itemId), itemId: l.itemId, quantity, unitPrice,
      discountAmount: lineDiscount, taxableAmount: taxable, taxAmount: lineTax, totalAmount: lineTotal,
      taxCodeId: effectiveTaxCodeId, components: calculatedComponents
    });
  }
  return { lines: lineOut, subtotalAmount: subtotal, discountAmount: discount, taxAmount: tax, totalAmount: total };
}
async function taxPreview({ orgId, payload }) {
  return withTx(async (client) => {
    const c = await calculateSale(client, orgId, payload);
    return {
      subtotalAmount: money(c.subtotalAmount), discountAmount: money(c.discountAmount), taxAmount: money(c.taxAmount), totalAmount: money(c.totalAmount),
      lines: c.lines.map(l => ({ lineNo: l.lineNo, itemId: l.itemId, quantity: qty(l.quantity), unitPrice: money(l.unitPrice), taxableAmount: money(l.taxableAmount), taxAmount: money(l.taxAmount), totalAmount: money(l.totalAmount), taxes: l.components.map(c => ({ taxCodeId: c.id, code: c.code, name: c.name, rate: String(c.rate), amount: c.taxAmount })) }))
    };
  });
}
async function assertShiftOpen(client, orgId, shiftId) {
  const { rows } = await client.query(`SELECT sh.*, st.warehouse_id FROM pos_shifts sh JOIN pos_stores st ON st.id=sh.store_id WHERE sh.organization_id=$1 AND sh.id=$2 FOR SHARE`, [orgId, shiftId]);
  if (!rows.length) throw new AppError(404, 'Shift not found');
  if (rows[0].status !== 'open') throw new AppError(409, 'Shift is not open');
  return rows[0];
}
async function reduceStockAndComputeCogs(client, orgId, warehouseId, line) {
  const { rows } = await client.query(
    `SELECT qty_on_hand, avg_unit_cost FROM inventory_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3 FOR UPDATE`, [orgId, warehouseId, line.itemId]);
  const bal = rows[0] || { qty_on_hand: '0', avg_unit_cost: '0' };
  if (D(bal.qty_on_hand).lt(line.quantity)) throw new AppError(409, `Insufficient stock for item ${line.item.sku || line.itemId}`);
  const unitCost = D(bal.avg_unit_cost || 0);
  const cogs = unitCost.mul(line.quantity);
  await client.query(
    `UPDATE inventory_balances SET qty_on_hand=qty_on_hand-$4::numeric, updated_at=now() WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`,
    [orgId, warehouseId, line.itemId, qty(line.quantity)]);
  return { unitCost, cogs };
}
async function createInventoryIssueRecord(client, orgId, sale, lines, actorUserId, warehouseId) {
  const period = await periodIF.findOpenPeriodForDate({ orgId, date: sale.sale_date, client });
  const { rows: txRows } = await client.query(
    `INSERT INTO inventory_transactions(organization_id, period_id, txn_date, txn_type, source_warehouse_id, reference, memo, status, status2, idempotency_key, created_by)
     VALUES($1,$2,$3,'issue',$4,$5,$6,'posted','posted',$7,$8) RETURNING id`,
    [orgId, period.id, sale.sale_date, warehouseId, sale.sale_no, `POS sale ${sale.sale_no}`, `POS-SALE:${sale.id}:INV`, actorUserId || null]);
  for (const l of lines) {
    await client.query(
      `INSERT INTO inventory_transaction_lines(transaction_id, item_id, quantity, unit_cost, extended_cost, direction) VALUES($1,$2,$3,$4,$5,'decrease')`,
      [txRows[0].id, l.itemId, qty(l.quantity), money(l.unitCost), money(l.cogsAmount)]);
  }
  await client.query(`UPDATE pos_sales SET inventory_transaction_id=$3 WHERE organization_id=$1 AND id=$2`, [orgId, sale.id, txRows[0].id]);
  return txRows[0].id;
}
async function createSale({ orgId, actorUserId, payload }) {
  ensureLines(payload?.lines);
  ensurePayments(payload?.payments);
  return withTx(async (client) => {
    const shift = await assertShiftOpen(client, orgId, payload.shiftId);
    const calc = await calculateSale(client, orgId, payload);
    const paid = payload.payments.reduce((a,p)=>a.plus(D(p.amount)), D(0));
    if (paid.lt(calc.totalAmount)) throw new AppError(400, 'Paid amount is less than sale total');
    const saleNo = payload.saleNo || await nextSaleNo(client, orgId);
    const currency = payload.currencyCode || await getOrgCurrency(client, orgId);
    const { rows: saleRows } = await client.query(
      `INSERT INTO pos_sales(organization_id, sale_no, channel, store_id, register_id, shift_id, warehouse_id, customer_id, cashier_user_id, sale_date, currency_code, tax_inclusive, subtotal_amount, discount_amount, tax_amount, total_amount, paid_amount, balance_amount, status, idempotency_key, source_order_id)
       VALUES($1,$2,COALESCE($3,'pos'),$4,$5,$6,$7,$8,$9,COALESCE($10::date,CURRENT_DATE),$11,$12,$13,$14,$15,$16,$17,$18,'completed',$19,$20)
       RETURNING *`, [orgId, saleNo, payload.channel || 'pos', shift.store_id, shift.register_id, shift.id, shift.warehouse_id, payload.customerId || null, actorUserId || null, payload.saleDate || null, currency, !!payload.taxInclusive, money(calc.subtotalAmount), money(calc.discountAmount), money(calc.taxAmount), money(calc.totalAmount), money(paid), money(paid.minus(calc.totalAmount)), payload.idempotencyKey || null, payload.sourceOrderId || null]);
    const sale = saleRows[0];
    let cogsTotal = D(0);
    const storedLines = [];
    for (const l of calc.lines) {
      const stock = await reduceStockAndComputeCogs(client, orgId, shift.warehouse_id, l);
      cogsTotal = cogsTotal.plus(stock.cogs);
      const { rows: lr } = await client.query(
        `INSERT INTO pos_sale_lines(organization_id, sale_id, line_no, item_id, description, quantity, unit_price, discount_amount, taxable_amount, tax_amount, total_amount, tax_code_id, unit_cost, cogs_amount)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [orgId, sale.id, l.lineNo, l.itemId, l.item.name, qty(l.quantity), money(l.unitPrice), money(l.discountAmount), money(l.taxableAmount), money(l.taxAmount), money(l.totalAmount), l.taxCodeId, money(stock.unitCost), money(stock.cogs)]);
      for (const c of l.components) {
        const componentTax = c.taxAmount;
        const { rows: taxRows } = await client.query(
          `INSERT INTO pos_sale_line_taxes(organization_id, sale_id, sale_line_id, source_tax_code_id, tax_code_id, tax_code, tax_name, rate, taxable_amount, tax_amount, tax_type, box_code, reporting_group)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [orgId, sale.id, lr[0].id, l.taxCodeId, c.id, c.code, c.name, c.rate, money(l.taxableAmount), componentTax, c.tax_type || null, c.box_code || null, c.reporting_group || null]);
        await syncPosTaxDetailToLedger({ client, orgId, saleId: sale.id, saleLineId: lr[0].id, detail: {
          ...taxRows[0],
          tax_scope: c.tax_scope || l.item.sales_tax_scope || 'taxable',
          direction: c.direction && c.direction !== 'both' ? c.direction : 'output',
          category_code: l.item.tax_profile_category || null,
          exemption_reason_code: l.item.exemption_reason_code || null,
          recoverable_percent: 0,
          reverse_charge: c.reverse_charge === true,
          metadata: {
            reportingGroup: c.reporting_group || null,
            taxProfileId: l.item.tax_profile_id || null,
            taxProfileCode: l.item.tax_profile_code || null,
            fiscalClassificationCode: l.item.fiscal_classification_code || null,
            hsCode: l.item.hs_code || null
          }
        }});
      }
      storedLines.push({ ...l, unitCost: stock.unitCost, cogsAmount: stock.cogs });
    }
    await client.query(`UPDATE pos_sales SET cogs_amount=$3 WHERE organization_id=$1 AND id=$2`, [orgId, sale.id, money(cogsTotal)]);
    for (const p of payload.payments) {
      if (!p.paymentMethodId || D(p.amount).lte(0)) throw new AppError(400, 'Each payment requires paymentMethodId and positive amount');
      await client.query(
        `INSERT INTO pos_sale_payments(organization_id, sale_id, shift_id, payment_method_id, amount, currency_code, provider_reference, status, captured_at, metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,'captured',now(),$8)`, [orgId, sale.id, shift.id, p.paymentMethodId, money(p.amount), currency, p.providerReference || null, p.metadata || {}]);
    }
    const invId = await createInventoryIssueRecord(client, orgId, { ...sale, cogs_amount: money(cogsTotal) }, storedLines, actorUserId, shift.warehouse_id);
    // GRA-5: completed POS sales get a fiscal snapshot in the same transaction.
    // Actual GRA transmission is handled by the durable queue outside the sale transaction.
    await fiscalizationSvc.autoPrepareForSource({ db: client, orgId, actorUserId, sourceType: 'pos_sale', sourceId: sale.id });
    return getSale({ orgId, saleId: sale.id, client, extra: { inventoryTransactionId: invId } });
  });
}
async function getSale({ orgId, saleId, client = null }) {
  const db = client || pool;
  const { rows } = await db.query(`SELECT s.*, bp.name AS customer_name, st.name AS store_name, r.name AS register_name FROM pos_sales s LEFT JOIN business_partners bp ON bp.id=s.customer_id LEFT JOIN pos_stores st ON st.id=s.store_id LEFT JOIN pos_registers r ON r.id=s.register_id WHERE s.organization_id=$1 AND s.id=$2`, [orgId, saleId]);
  if (!rows.length) throw new AppError(404, 'Sale not found');
  const { rows: lines } = await db.query(`SELECT l.*, i.sku, i.name AS item_name FROM pos_sale_lines l JOIN inventory_items i ON i.id=l.item_id WHERE l.organization_id=$1 AND l.sale_id=$2 ORDER BY l.line_no`, [orgId, saleId]);
  const { rows: taxes } = await db.query(`SELECT * FROM pos_sale_line_taxes WHERE organization_id=$1 AND sale_id=$2 ORDER BY tax_code`, [orgId, saleId]);
  const { rows: payments } = await db.query(`SELECT p.*, pm.code AS payment_method_code, pm.name AS payment_method_name FROM pos_sale_payments p JOIN payment_methods pm ON pm.id=p.payment_method_id WHERE p.organization_id=$1 AND p.sale_id=$2`, [orgId, saleId]);
  return { ...rows[0], lines, taxes, payments };
}
async function listSales({ orgId, query = {} }) {
  const params = [orgId]; const where = [`s.organization_id=$1`]; let n=2;
  if (query.status) { where.push(`s.status=$${n++}`); params.push(query.status); }
  if (query.from) { where.push(`s.sale_date >= $${n++}`); params.push(query.from); }
  if (query.to) { where.push(`s.sale_date <= $${n++}`); params.push(query.to); }
  if (query.storeId) { where.push(`s.store_id=$${n++}`); params.push(query.storeId); }
  const { rows } = await pool.query(`SELECT s.id, s.sale_no, s.channel, s.sale_date, s.status, s.total_amount, s.paid_amount, s.balance_amount, bp.name AS customer_name, st.name AS store_name FROM pos_sales s LEFT JOIN business_partners bp ON bp.id=s.customer_id LEFT JOIN pos_stores st ON st.id=s.store_id WHERE ${where.join(' AND ')} ORDER BY s.sale_date DESC, s.created_at DESC LIMIT 200`, params);
  return { data: rows };
}
async function getPostingProfile(client, orgId) {
  const { rows } = await client.query(`SELECT * FROM pos_accounting_profiles WHERE organization_id=$1 AND is_default=true AND status='active' ORDER BY created_at LIMIT 1`, [orgId]);
  if (!rows.length) throw new AppError(409, 'Default POS accounting profile is not configured');
  return rows[0];
}
async function postSale({ orgId, actorUserId, saleId, payload = {} }) {
  return withTx(async (client) => {
    const sale = await getSale({ orgId, saleId, client });
    if (sale.status !== 'completed') throw new AppError(409, 'Only completed sales can be posted');
    if (sale.posted_journal_entry_id) return { saleId, journalId: sale.posted_journal_entry_id, idempotent: true };
    const profile = await getPostingProfile(client, orgId);
    const taxSettings = (await client.query(`SELECT output_tax_account_id FROM tax_settings WHERE organization_id=$1`, [orgId])).rows[0] || {};
    if (!profile.sales_revenue_account_id || !profile.cogs_account_id || !profile.inventory_account_id) throw new AppError(409, 'POS accounting profile missing revenue/COGS/inventory accounts');
    const period = await periodIF.findOpenPeriodForDate({ orgId, date: sale.sale_date, client });
    const lines = [];
    const payments = sale.payments || [];
    for (const p of payments) {
      const pm = (await client.query(`SELECT pm.*, pmp.clearing_account_id FROM payment_methods pm LEFT JOIN pos_payment_method_profiles pmp ON pmp.organization_id=pm.organization_id AND pmp.payment_method_id=pm.id AND pmp.pos_accounting_profile_id=$3 WHERE pm.organization_id=$1 AND pm.id=$2`, [orgId, p.payment_method_id, profile.id])).rows[0];
      const acct = pm?.clearing_account_id || profile.default_cash_account_id;
      if (!acct) throw new AppError(409, `No clearing/cash account mapped for payment method ${pm?.code || p.payment_method_id}`);
      lines.push({ accountId: acct, debit: p.amount, credit: 0, description: `POS payment ${sale.sale_no} - ${pm.code}` });
    }
    if (D(sale.discount_amount).gt(0)) {
      if (!profile.discount_account_id) throw new AppError(409, 'Discount account is required when sale has discounts');
      lines.push({ accountId: profile.discount_account_id, debit: sale.discount_amount, credit: 0, description: `POS discounts ${sale.sale_no}` });
    }
    lines.push({ accountId: profile.sales_revenue_account_id, debit: 0, credit: sale.subtotal_amount, description: `POS revenue ${sale.sale_no}` });
    const taxesByCode = new Map();
    for (const t of sale.taxes || []) {
      const key = t.tax_code_id || t.tax_code;
      const prev = taxesByCode.get(key) || { amount: D(0), label: t.tax_code, accountId: taxSettings.output_tax_account_id };
      prev.amount = prev.amount.plus(D(t.tax_amount));
      taxesByCode.set(key, prev);
    }
    for (const t of taxesByCode.values()) {
      if (t.amount.gt(0)) {
        if (!t.accountId) throw new AppError(409, 'Output tax account is not configured');
        lines.push({ accountId: t.accountId, debit: 0, credit: money(t.amount), description: `POS output tax ${sale.sale_no} ${t.label || ''}` });
      }
    }
    if (D(sale.cogs_amount).gt(0)) {
      lines.push({ accountId: profile.cogs_account_id, debit: sale.cogs_amount, credit: 0, description: `POS COGS ${sale.sale_no}` });
      lines.push({ accountId: profile.inventory_account_id, debit: 0, credit: sale.cogs_amount, description: `POS inventory issue ${sale.sale_no}` });
    }
    const posted = await journalIF.postJournal({ orgId, actorUserId, client, payload: { periodId: period.id, entryDate: sale.sale_date, memo: payload.memo || `POS sale ${sale.sale_no}`, idempotencyKey: `POS:SALE:${sale.id}:POST`, lines } });
    await client.query(`UPDATE pos_sales SET status='posted', posted_at=now(), posted_by=$3, posted_journal_entry_id=$4, updated_at=now() WHERE organization_id=$1 AND id=$2`, [orgId, sale.id, actorUserId || null, posted.journalId]);
    return { saleId: sale.id, journalId: posted.journalId, status: 'posted' };
  });
}
async function voidSale({ orgId, actorUserId, saleId, payload = {} }) {
  return withTx(async (client) => {
    const sale = await getSale({ orgId, saleId, client });
    if (!['completed'].includes(sale.status)) throw new AppError(409, 'Only unposted completed sales can be voided');
    for (const l of sale.lines) {
      await client.query(`UPDATE inventory_balances SET qty_on_hand=qty_on_hand+$4::numeric, updated_at=now() WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`, [orgId, sale.warehouse_id, l.item_id, l.quantity]);
    }
    await client.query(`UPDATE pos_sales SET status='voided', voided_at=now(), voided_by=$3, void_reason=$4, updated_at=now() WHERE organization_id=$1 AND id=$2`, [orgId, saleId, actorUserId || null, payload.reason || null]);
    return { saleId, status: 'voided' };
  });
}
async function refundSale({ orgId, actorUserId, saleId, payload = {} }) {
  return withTx(async (client) => {
    const sale = await getSale({ orgId, saleId, client });
    if (!['posted','completed'].includes(sale.status)) throw new AppError(409, 'Only completed or posted sales can be refunded');
    const amount = D(payload.amount || sale.total_amount);
    if (amount.lte(0) || amount.gt(D(sale.total_amount))) throw new AppError(400, 'Invalid refund amount');
    const { rows } = await client.query(
      `INSERT INTO pos_refunds(organization_id, sale_id, amount, reason, status, created_by) VALUES($1,$2,$3,$4,'approved',$5) RETURNING *`, [orgId, saleId, money(amount), payload.reason || null, actorUserId || null]);
    await client.query(`UPDATE pos_sales SET status=CASE WHEN $3::numeric >= total_amount THEN 'refunded' ELSE 'partially_refunded' END, updated_at=now() WHERE organization_id=$1 AND id=$2`, [orgId, saleId, money(amount)]);
    return rows[0];
  });
}
async function receiptData({ orgId, saleId }) {
  const sale = await getSale({ orgId, saleId });
  const { rows: orgRows } = await pool.query(`SELECT name, base_currency_code FROM organizations WHERE id=$1`, [orgId]);
  const { rows: fiscalRows } = await pool.query(
    `SELECT id,status,is_simulation,commissioner_general_signature,qr_code,receipt_signature,invoice_signature,verification_engine_id,
            fiscal_timestamp,serial_number,receipt_number,machine_registration_code,gra_reference,offline_deadline_at
       FROM fiscal_documents WHERE organization_id=$1 AND source_type='pos_sale' AND source_id=$2`,
    [orgId, saleId]
  );
  return {
    organization: orgRows[0] || {}, sale,
    receipt: { title: 'Sales Receipt', receiptNo: sale.sale_no, printedAt: new Date().toISOString() },
    fiscal: fiscalRows[0] || null
  };
}

async function createOrder({ orgId, actorUserId, payload }) {
  ensureLines(payload?.lines);
  return withTx(async (client) => {
    const calc = await calculateSale(client, orgId, { ...payload, taxInclusive: !!payload.taxInclusive });
    const orderNo = payload.orderNo || await nextOrderNo(client);
    const currency = payload.currencyCode || await getOrgCurrency(client, orgId);
    const { rows } = await client.query(
      `INSERT INTO commerce_orders(organization_id, order_no, channel_code, customer_id, status, order_date, currency_code, tax_inclusive, subtotal_amount, discount_amount, tax_amount, total_amount, created_by, metadata)
       VALUES($1,$2,COALESCE($3,'web'),$4,COALESCE($14,'pending_payment'),COALESCE($5::date,CURRENT_DATE),$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [orgId, orderNo, payload.channelCode || null, payload.customerId || null, payload.orderDate || null, currency, !!payload.taxInclusive, money(calc.subtotalAmount), money(calc.discountAmount), money(calc.taxAmount), money(calc.totalAmount), actorUserId || null, payload.metadata || {}, ['cart','pending_payment','draft'].includes(payload.status) ? payload.status : 'pending_payment']);
    for (const l of calc.lines) {
      await client.query(
        `INSERT INTO commerce_order_lines(organization_id, order_id, line_no, item_id, description, quantity, unit_price, discount_amount, taxable_amount, tax_amount, total_amount, tax_code_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [orgId, rows[0].id, l.lineNo, l.itemId, l.item.name, qty(l.quantity), money(l.unitPrice), money(l.discountAmount), money(l.taxableAmount), money(l.taxAmount), money(l.totalAmount), l.taxCodeId]);
    }
    return rows[0];
  });
}
async function listOrders({ orgId, query = {} }) {
  const params = [orgId]; const where = [`o.organization_id=$1`]; let n=2;
  if (query.status) { where.push(`o.status=$${n++}`); params.push(query.status); }
  const { rows } = await pool.query(`SELECT o.*, bp.name AS customer_name FROM commerce_orders o LEFT JOIN business_partners bp ON bp.id=o.customer_id WHERE ${where.join(' AND ')} ORDER BY order_date DESC, created_at DESC LIMIT 200`, params);
  return { data: rows };
}
async function markOrderPaid({ orgId, orderId, payload }) {
  const { rows } = await pool.query(`UPDATE commerce_orders SET status='paid', paid_at=now(), updated_at=now(), metadata=metadata || $3::jsonb WHERE organization_id=$1 AND id=$2 AND status IN ('pending_payment','payment_failed') RETURNING *`, [orgId, orderId, JSON.stringify({ payment: payload || {} })]);
  if (!rows.length) throw new AppError(404, 'Order not found or cannot be paid');
  return rows[0];
}
async function fulfillOrderToSale({ orgId, actorUserId, orderId, payload }) {
  const { rows: oRows } = await pool.query(`SELECT * FROM commerce_orders WHERE organization_id=$1 AND id=$2`, [orgId, orderId]);
  if (!oRows.length) throw new AppError(404, 'Order not found');
  const order = oRows[0];
  if (!['paid','processing'].includes(order.status)) throw new AppError(409, 'Only paid/processing orders can be fulfilled');
  const { rows: lines } = await pool.query(`SELECT item_id AS "itemId", quantity, unit_price AS "unitPrice", discount_amount AS "discountAmount", tax_code_id AS "taxCodeId" FROM commerce_order_lines WHERE organization_id=$1 AND order_id=$2 ORDER BY line_no`, [orgId, orderId]);
  const sale = await createSale({ orgId, actorUserId, payload: { shiftId: payload.shiftId, customerId: order.customer_id, channel: 'ecommerce', sourceOrderId: order.id, taxInclusive: order.tax_inclusive, lines, payments: payload.payments || [] } });
  await pool.query(`UPDATE commerce_orders SET status='fulfilled', fulfilled_at=now(), pos_sale_id=$3, updated_at=now() WHERE organization_id=$1 AND id=$2`, [orgId, orderId, sale.id]);
  return { orderId, saleId: sale.id, status: 'fulfilled' };
}

async function dailySalesReport({ orgId, query = {} }) {
  const from = query.from || new Date().toISOString().slice(0,10); const to = query.to || from;
  const { rows } = await pool.query(
    `SELECT sale_date, COUNT(*)::int sale_count, COALESCE(SUM(subtotal_amount),0)::text subtotal, COALESCE(SUM(discount_amount),0)::text discounts, COALESCE(SUM(tax_amount),0)::text tax, COALESCE(SUM(total_amount),0)::text total, COALESCE(SUM(cogs_amount),0)::text cogs, COALESCE(SUM(total_amount-cogs_amount),0)::text gross_margin
       FROM pos_sales WHERE organization_id=$1 AND sale_date BETWEEN $2 AND $3 AND status NOT IN ('voided') GROUP BY sale_date ORDER BY sale_date`, [orgId, from, to]);
  return { from, to, data: rows };
}
async function productSalesReport({ orgId, query = {} }) {
  const from = query.from || '1900-01-01'; const to = query.to || '2999-12-31';
  const { rows } = await pool.query(
    `SELECT i.sku, i.name, COALESCE(SUM(l.quantity),0)::text quantity, COALESCE(SUM(l.total_amount),0)::text sales, COALESCE(SUM(l.cogs_amount),0)::text cogs, COALESCE(SUM(l.total_amount-l.cogs_amount),0)::text gross_margin
       FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id JOIN inventory_items i ON i.id=l.item_id
      WHERE l.organization_id=$1 AND s.sale_date BETWEEN $2 AND $3 AND s.status NOT IN ('voided')
      GROUP BY i.sku, i.name ORDER BY sales::numeric DESC LIMIT 200`, [orgId, from, to]);
  return { from, to, data: rows };
}
async function paymentReconciliationReport({ orgId, query = {} }) {
  const from = query.from || '1900-01-01'; const to = query.to || '2999-12-31';
  const { rows } = await pool.query(
    `SELECT pm.code, pm.name, COUNT(*)::int payment_count, COALESCE(SUM(p.amount),0)::text amount
       FROM pos_sale_payments p JOIN pos_sales s ON s.id=p.sale_id JOIN payment_methods pm ON pm.id=p.payment_method_id
      WHERE p.organization_id=$1 AND s.sale_date BETWEEN $2 AND $3 AND p.status='captured'
      GROUP BY pm.code, pm.name ORDER BY pm.code`, [orgId, from, to]);
  return { from, to, data: rows };
}
async function taxSummaryReport({ orgId, query = {} }) {
  const from = query.from || '1900-01-01'; const to = query.to || '2999-12-31';
  const { rows } = await pool.query(
    `SELECT COALESCE(tc.code, tle.metadata->>'taxCode') AS tax_code,
            COALESCE(tc.name, tle.metadata->>'taxName') AS tax_name,
            tle.tax_rate::text AS rate,
            COALESCE(tle.tax_type,tc.tax_type) AS tax_type,
            COALESCE(tle.box_code,tc.box_code) AS box_code,
            COALESCE(tle.metadata->>'reportingGroup',tc.reporting_group) AS reporting_group,
            COALESCE(SUM(tle.taxable_amount * tle.sign_factor),0)::text AS taxable_amount,
            COALESCE(SUM(tle.tax_amount * tle.sign_factor),0)::text AS tax_amount
       FROM tax_ledger_entries tle
       LEFT JOIN tax_codes tc ON tc.id=tle.tax_code_id
      WHERE tle.organization_id=$1
        AND tle.document_date BETWEEN $2::date AND $3::date
        AND (
          (tle.source_type='pos_sale' AND EXISTS (
            SELECT 1 FROM pos_sales s WHERE s.organization_id=tle.organization_id AND s.id=tle.source_id
              AND s.status IN ('completed','posted','partially_returned','returned','partially_refunded','refunded')
          )) OR
          (tle.source_type='pos_return' AND EXISTS (
            SELECT 1 FROM pos_return_authorizations r WHERE r.organization_id=tle.organization_id AND r.id=tle.source_id AND r.status='received'
          ))
        )
      GROUP BY tc.code, tc.name, tle.tax_rate, COALESCE(tle.tax_type,tc.tax_type), COALESCE(tle.box_code,tc.box_code), COALESCE(tle.metadata->>'reportingGroup',tc.reporting_group)
      ORDER BY tax_code`, [orgId, from, to]);
  return { from, to, data: rows };
}


async function createReturn({ orgId, actorUserId, payload }) {
  payload = normalizePayload(payload || {});
  if (!payload?.saleId) throw new AppError(400, 'saleId is required');
  return withTx(async (client) => {
    const sale = await getSale({ orgId, saleId: payload.saleId, client });
    if (!['completed','posted','partially_returned'].includes(sale.status)) throw new AppError(409, 'Only completed or posted sales can be returned');
    let returnLines = Array.isArray(payload.lines) && payload.lines.length ? payload.lines : [];
    if (!returnLines.length) {
      const { rows: saleLines } = await client.query(`SELECT id AS "saleLineId", item_id AS "itemId", quantity, total_amount AS "refundAmount" FROM pos_sale_lines WHERE organization_id=$1 AND sale_id=$2 ORDER BY line_no`, [orgId, payload.saleId]);
      returnLines = saleLines.map(l => ({ ...l, restockAction: payload.disposition || 'restock' }));
    }
    if (!returnLines.length) throw new AppError(400, 'No sale lines available to return');
    const { rows: noRows } = await client.query(`SELECT nextval('pos_return_no_seq') AS n`);
    const returnNo = payload.returnNo || `RTN-${String(noRows[0].n).padStart(8, '0')}`;
    const { rows } = await client.query(
      `INSERT INTO pos_return_authorizations(organization_id, sale_id, return_no, reason, status, created_by, metadata)
       VALUES($1,$2,$3,$4,'draft',$5,$6) RETURNING *`, [orgId, payload.saleId, returnNo, payload.reason || null, actorUserId || null, payload.metadata || {}]);
    for (const line of returnLines) {
      if (!line.itemId || D(line.quantity).lte(0)) throw new AppError(400, 'Each return line requires itemId and positive quantity');
      let saleLineId = line.saleLineId || null;
      if (saleLineId) {
        const { rows: matched } = await client.query(
          `SELECT id, item_id FROM pos_sale_lines WHERE organization_id=$1 AND sale_id=$2 AND id=$3`,
          [orgId, payload.saleId, saleLineId]
        );
        if (!matched.length || matched[0].item_id !== line.itemId) throw new AppError(400, 'Return line does not match the original sale line');
      } else {
        const { rows: candidates } = await client.query(
          `SELECT id FROM pos_sale_lines WHERE organization_id=$1 AND sale_id=$2 AND item_id=$3 ORDER BY line_no`,
          [orgId, payload.saleId, line.itemId]
        );
        if (candidates.length !== 1) throw new AppError(400, 'saleLineId is required when an item appears more than once on the sale');
        saleLineId = candidates[0].id;
      }
      await client.query(
        `INSERT INTO pos_return_lines(organization_id, return_id, sale_line_id, item_id, quantity, refund_amount, restock_action)
         VALUES($1,$2,$3,$4,$5,$6,$7)`, [orgId, rows[0].id, saleLineId, line.itemId, qty(line.quantity), money(line.refundAmount || 0), line.restockAction || payload.disposition || 'restock']);
    }
    return rows[0];
  });
}
async function approveReturn({ orgId, actorUserId, returnId }) {
  const { rows } = await pool.query(`UPDATE pos_return_authorizations SET status='approved', approved_by=$3, approved_at=now(), updated_at=now() WHERE organization_id=$1 AND id=$2 AND status IN ('draft','rejected') RETURNING *`, [orgId, returnId, actorUserId || null]);
  if (!rows.length) throw new AppError(404, 'Return not found or cannot be approved');
  return rows[0];
}
async function rejectReturn({ orgId, actorUserId, returnId, payload = {} }) {
  const { rows } = await pool.query(`UPDATE pos_return_authorizations SET status='rejected', metadata=metadata || $4::jsonb, updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='draft' RETURNING *`, [orgId, returnId, actorUserId || null, JSON.stringify({ rejectReason: payload.reason || null, rejectedBy: actorUserId || null })]);
  if (!rows.length) throw new AppError(404, 'Return not found or cannot be rejected');
  return rows[0];
}
async function receiveReturn({ orgId, actorUserId, returnId }) {
  return withTx(async (client) => {
    const { rows: rRows } = await client.query(`SELECT r.*, s.warehouse_id, s.id AS sale_id FROM pos_return_authorizations r JOIN pos_sales s ON s.id=r.sale_id WHERE r.organization_id=$1 AND r.id=$2 FOR UPDATE`, [orgId, returnId]);
    if (!rRows.length) throw new AppError(404, 'Return not found');
    const ret = rRows[0];
    if (ret.status !== 'approved') throw new AppError(409, 'Only approved returns can be received');
    const { rows: lines } = await client.query(`SELECT * FROM pos_return_lines WHERE organization_id=$1 AND return_id=$2 ORDER BY created_at, id`, [orgId, returnId]);
    for (const line of lines) {
      const { rows: saleLineRows } = await client.query(
        `SELECT sl.*,
                COALESCE((
                  SELECT SUM(rl2.quantity)
                    FROM pos_return_lines rl2
                    JOIN pos_return_authorizations r2 ON r2.id=rl2.return_id
                   WHERE rl2.organization_id=sl.organization_id
                     AND rl2.sale_line_id=sl.id
                     AND r2.status='received'
                     AND r2.id<>$4
                ),0) AS previously_returned_quantity
           FROM pos_sale_lines sl
          WHERE sl.organization_id=$1 AND sl.sale_id=$2 AND sl.id=$3
          FOR UPDATE`,
        [orgId, ret.sale_id, line.sale_line_id, returnId]
      );
      if (!saleLineRows.length) throw new AppError(409, 'Original sale line for return was not found');
      const saleLine = saleLineRows[0];
      const previousQty = D(saleLine.previously_returned_quantity || 0);
      const thisQty = D(line.quantity);
      const soldQty = D(saleLine.quantity);
      const cumulativeQty = previousQty.plus(thisQty);
      if (cumulativeQty.gt(soldQty)) throw new AppError(409, 'Returned quantity exceeds quantity originally sold');
      const completesLineReturn = cumulativeQty.eq(soldQty);

      const { rows: originalTaxes } = await client.query(
        `SELECT st.*, COALESCE(tc.tax_scope,'taxable') AS tax_scope, COALESCE(tc.direction,'output') AS direction,
                tc.category_code, tc.reverse_charge
           FROM pos_sale_line_taxes st
           LEFT JOIN tax_codes tc ON tc.id=st.tax_code_id
          WHERE st.organization_id=$1 AND st.sale_line_id=$2
          ORDER BY st.created_at, st.id`,
        [orgId, saleLine.id]
      );

      for (const sourceTax of originalTaxes) {
        const { rows: prior } = await client.query(
          `SELECT COALESCE(SUM(taxable_amount),0)::text AS taxable_amount,
                  COALESCE(SUM(tax_amount),0)::text AS tax_amount
             FROM pos_return_line_taxes
            WHERE organization_id=$1 AND sale_line_tax_id=$2`,
          [orgId, sourceTax.id]
        );
        const remainingTaxable = D(sourceTax.taxable_amount || 0).minus(D(prior[0]?.taxable_amount || 0));
        const remainingTax = D(sourceTax.tax_amount || 0).minus(D(prior[0]?.tax_amount || 0));
        let returnedTaxable;
        let returnedTax;
        if (completesLineReturn) {
          returnedTaxable = remainingTaxable;
          returnedTax = remainingTax;
        } else {
          const ratio = thisQty.div(soldQty);
          returnedTaxable = D(sourceTax.taxable_amount || 0).mul(ratio).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
          returnedTax = D(sourceTax.tax_amount || 0).mul(ratio).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
          if (returnedTaxable.gt(remainingTaxable)) returnedTaxable = remainingTaxable;
          if (returnedTax.gt(remainingTax)) returnedTax = remainingTax;
        }
        const { rows: taxRows } = await client.query(
          `INSERT INTO pos_return_line_taxes(
             organization_id, return_id, return_line_id, sale_line_tax_id,
             source_tax_code_id, tax_code_id, tax_code, tax_name, rate,
             taxable_amount, tax_amount, tax_type, tax_scope, direction, box_code,
             reporting_group, category_code, exemption_reason_code, reverse_charge, metadata
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
           ON CONFLICT (organization_id, return_line_id, sale_line_tax_id) DO NOTHING
           RETURNING *`,
          [orgId, returnId, line.id, sourceTax.id,
           sourceTax.source_tax_code_id, sourceTax.tax_code_id, sourceTax.tax_code, sourceTax.tax_name, sourceTax.rate,
           money(returnedTaxable), money(returnedTax), sourceTax.tax_type, sourceTax.tax_scope, sourceTax.direction,
           sourceTax.box_code, sourceTax.reporting_group, sourceTax.category_code, null, sourceTax.reverse_charge === true,
           JSON.stringify({ saleId: ret.sale_id, originalSaleLineId: saleLine.id })]
        );
        if (taxRows.length) {
          await syncPosReturnTaxDetailToLedger({ client, orgId, returnId, returnLineId: line.id, detail: {
            ...taxRows[0],
            tax_rate: taxRows[0].rate,
            recoverable_percent: 0,
          }});
        }
      }

      if (line.restock_action === 'restock') {
        await client.query(`UPDATE inventory_balances SET qty_on_hand=qty_on_hand+$4::numeric, updated_at=now() WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3`, [orgId, ret.warehouse_id, line.item_id, line.quantity]);
      }
    }
    await client.query(`UPDATE pos_return_authorizations SET status='received', received_by=$3, received_at=now(), updated_at=now() WHERE organization_id=$1 AND id=$2`, [orgId, returnId, actorUserId || null]);
    const { rows: returnState } = await client.query(
      `SELECT NOT EXISTS (
         SELECT 1
           FROM pos_sale_lines sl
          WHERE sl.organization_id=$1 AND sl.sale_id=$2
            AND COALESCE((
              SELECT SUM(rl.quantity)
                FROM pos_return_lines rl
                JOIN pos_return_authorizations r ON r.id=rl.return_id
               WHERE rl.organization_id=sl.organization_id AND rl.sale_line_id=sl.id AND r.status='received'
            ),0) < sl.quantity
       ) AS fully_returned`,
      [orgId, ret.sale_id]
    );
    const saleStatus = returnState[0]?.fully_returned ? 'returned' : 'partially_returned';
    await client.query(`UPDATE pos_sales SET status=$3, updated_at=now() WHERE organization_id=$1 AND id=$2 AND status <> 'voided'`, [orgId, ret.sale_id, saleStatus]);
    return { returnId, status: 'received', saleStatus };
  });
}

async function createRefund({ orgId, actorUserId, payload }) {
  if (!payload?.saleId || D(payload.amount).lte(0)) throw new AppError(400, 'saleId and positive amount are required');
  const { rows } = await pool.query(
    `INSERT INTO pos_refunds(organization_id, sale_id, amount, reason, status, created_by)
     VALUES($1,$2,$3,$4,'draft',$5) RETURNING *`, [orgId, payload.saleId, money(payload.amount), payload.reason || null, actorUserId || null]);
  return rows[0];
}
async function approveRefund({ orgId, refundId }) {
  const { rows } = await pool.query(`UPDATE pos_refunds SET status='approved', updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='draft' RETURNING *`, [orgId, refundId]);
  if (!rows.length) throw new AppError(404, 'Refund not found or cannot be approved');
  return rows[0];
}
async function postRefund({ orgId, actorUserId, refundId, payload = {} }) {
  const { rows } = await pool.query(`UPDATE pos_refunds SET status='posted', updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='approved' RETURNING *`, [orgId, refundId]);
  if (!rows.length) throw new AppError(404, 'Refund not found or cannot be posted');
  await pool.query(`UPDATE pos_sales SET status='partially_refunded', updated_at=now() WHERE organization_id=$1 AND id=$2 AND status IN ('completed','posted','partially_returned')`, [orgId, rows[0].sale_id]);
  return { ...rows[0], posted: true };
}

async function listPromotions({ orgId }) {
  const { rows } = await pool.query(`SELECT * FROM commerce_promotions WHERE organization_id=$1 ORDER BY created_at DESC`, [orgId]);
  return { data: rows };
}
async function createPromotion({ orgId, payload }) {
  if (!payload?.code || !payload?.name || !payload?.promotionType) throw new AppError(400, 'code, name and promotionType are required');
  const { rows } = await pool.query(
    `INSERT INTO commerce_promotions(organization_id, code, name, promotion_type, discount_value, starts_at, ends_at, min_spend_amount, max_discount_amount, requires_approval, status, metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'active'),$12)
     ON CONFLICT (organization_id, code) DO UPDATE SET name=EXCLUDED.name, promotion_type=EXCLUDED.promotion_type, discount_value=EXCLUDED.discount_value, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, min_spend_amount=EXCLUDED.min_spend_amount, max_discount_amount=EXCLUDED.max_discount_amount, requires_approval=EXCLUDED.requires_approval, status=EXCLUDED.status, metadata=EXCLUDED.metadata, updated_at=now()
     RETURNING *`, [orgId, payload.code, payload.name, payload.promotionType, money(payload.discountValue || 0), payload.startsAt || null, payload.endsAt || null, payload.minSpendAmount == null ? null : money(payload.minSpendAmount), payload.maxDiscountAmount == null ? null : money(payload.maxDiscountAmount), !!payload.requiresApproval, payload.status || 'active', payload.metadata || {}]);
  return rows[0];
}
async function updatePromotion({ orgId, promotionId, payload }) {
  const { rows } = await pool.query(`UPDATE commerce_promotions SET name=COALESCE($3,name), discount_value=COALESCE($4,discount_value), status=COALESCE($5,status), updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, promotionId, payload.name ?? null, payload.discountValue == null ? null : money(payload.discountValue), payload.status ?? null]);
  if (!rows.length) throw new AppError(404, 'Promotion not found');
  return rows[0];
}
async function applyPromotionPreview({ orgId, payload }) {
  const subtotal = D(payload?.subtotal || 0);
  let discount = D(0);
  let approvalRequired = false;
  if (payload?.promotionId) {
    const { rows } = await pool.query(`SELECT * FROM commerce_promotions WHERE organization_id=$1 AND id=$2 AND status='active'`, [orgId, payload.promotionId]);
    if (!rows.length) throw new AppError(404, 'Promotion not found');
    const p = rows[0];
    if (p.min_spend_amount && subtotal.lt(D(p.min_spend_amount))) throw new AppError(400, 'Minimum spend not reached');
    discount = p.promotion_type === 'percentage' ? subtotal.mul(D(p.discount_value)).div(100) : D(p.discount_value);
    if (p.max_discount_amount) discount = Decimal.min(discount, D(p.max_discount_amount));
    approvalRequired = !!p.requires_approval;
  }
  return { subtotal: money(subtotal), discountAmount: money(discount), netAmount: money(subtotal.minus(discount)), approvalRequired };
}
async function listCoupons({ orgId }) {
  const { rows } = await pool.query(`SELECT * FROM commerce_coupons WHERE organization_id=$1 ORDER BY created_at DESC`, [orgId]);
  return { data: rows };
}
async function createCoupon({ orgId, payload }) {
  if (!payload?.code) throw new AppError(400, 'code is required');
  const { rows } = await pool.query(`INSERT INTO commerce_coupons(organization_id, code, promotion_id, usage_limit, status, starts_at, ends_at) VALUES($1,$2,$3,$4,COALESCE($5,'active'),$6,$7) ON CONFLICT (organization_id, code) DO UPDATE SET promotion_id=EXCLUDED.promotion_id, usage_limit=EXCLUDED.usage_limit, status=EXCLUDED.status, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, updated_at=now() RETURNING *`, [orgId, payload.code, payload.promotionId || null, payload.usageLimit || null, payload.status || 'active', payload.startsAt || null, payload.endsAt || null]);
  return rows[0];
}
async function validateCoupon({ orgId, payload }) {
  const { rows } = await pool.query(`SELECT c.*, p.name AS promotion_name, p.promotion_type, p.discount_value FROM commerce_coupons c LEFT JOIN commerce_promotions p ON p.id=c.promotion_id WHERE c.organization_id=$1 AND c.code=$2 AND c.status='active'`, [orgId, payload?.code]);
  if (!rows.length) throw new AppError(404, 'Coupon not found or inactive');
  const c = rows[0];
  if (c.usage_limit && c.used_count >= c.usage_limit) throw new AppError(409, 'Coupon usage limit reached');
  return { valid: true, coupon: c };
}

async function getLoyalty({ orgId, customerId }) {
  const { rows } = await pool.query(`INSERT INTO commerce_loyalty_accounts(organization_id, customer_id) VALUES($1,$2) ON CONFLICT (organization_id, customer_id) DO UPDATE SET updated_at=now() RETURNING *`, [orgId, customerId]);
  const ledger = await pool.query(`SELECT * FROM commerce_loyalty_ledger WHERE organization_id=$1 AND loyalty_account_id=$2 ORDER BY created_at DESC LIMIT 50`, [orgId, rows[0].id]);
  return { account: rows[0], ledger: ledger.rows };
}
async function adjustLoyalty({ orgId, actorUserId, customerId, payload }) {
  return withTx(async (client) => {
    const { rows } = await client.query(`INSERT INTO commerce_loyalty_accounts(organization_id, customer_id) VALUES($1,$2) ON CONFLICT (organization_id, customer_id) DO UPDATE SET updated_at=now() RETURNING *`, [orgId, customerId]);
    const points = D(payload.points || 0);
    await client.query(`UPDATE commerce_loyalty_accounts SET points_balance=points_balance+$3::numeric, updated_at=now() WHERE organization_id=$1 AND id=$2`, [orgId, rows[0].id, points.toFixed(2)]);
    await client.query(`INSERT INTO commerce_loyalty_ledger(organization_id, loyalty_account_id, movement_type, points, note, created_by) VALUES($1,$2,COALESCE($3,'adjustment'),$4,$5,$6)`, [orgId, rows[0].id, payload.movementType || 'adjustment', points.toFixed(2), payload.note || null, actorUserId || null]);
    return getLoyalty({ orgId, customerId });
  });
}
async function getStoreCredit({ orgId, customerId }) {
  const currency = (await pool.query(`SELECT base_currency_code FROM organizations WHERE id=$1`, [orgId])).rows[0]?.base_currency_code || 'GHS';
  const { rows } = await pool.query(`INSERT INTO commerce_store_credit_accounts(organization_id, customer_id, currency_code) VALUES($1,$2,$3) ON CONFLICT (organization_id, customer_id) DO UPDATE SET updated_at=now() RETURNING *`, [orgId, customerId, currency]);
  const ledger = await pool.query(`SELECT * FROM commerce_store_credit_ledger WHERE organization_id=$1 AND store_credit_account_id=$2 ORDER BY created_at DESC LIMIT 50`, [orgId, rows[0].id]);
  return { account: rows[0], ledger: ledger.rows };
}
async function adjustStoreCredit({ orgId, actorUserId, customerId, payload }) {
  return withTx(async (client) => {
    const currency = (await client.query(`SELECT base_currency_code FROM organizations WHERE id=$1`, [orgId])).rows[0]?.base_currency_code || 'GHS';
    const { rows } = await client.query(`INSERT INTO commerce_store_credit_accounts(organization_id, customer_id, currency_code) VALUES($1,$2,$3) ON CONFLICT (organization_id, customer_id) DO UPDATE SET updated_at=now() RETURNING *`, [orgId, customerId, currency]);
    const amount = D(payload.amount || 0);
    await client.query(`UPDATE commerce_store_credit_accounts SET balance_amount=balance_amount+$3::numeric, updated_at=now() WHERE organization_id=$1 AND id=$2`, [orgId, rows[0].id, money(amount)]);
    await client.query(`INSERT INTO commerce_store_credit_ledger(organization_id, store_credit_account_id, movement_type, amount, note, created_by) VALUES($1,$2,COALESCE($3,'adjustment'),$4,$5,$6)`, [orgId, rows[0].id, payload.movementType || 'adjustment', money(amount), payload.note || null, actorUserId || null]);
    return getStoreCredit({ orgId, customerId });
  });
}

async function recordCashCount({ orgId, actorUserId, payload }) {
  if (!payload?.shiftId) throw new AppError(400, 'shiftId is required');
  const expected = D(payload.expectedAmount || 0), counted = D(payload.countedAmount || 0);
  const { rows } = await pool.query(`INSERT INTO pos_cash_counts(organization_id, shift_id, counted_amount, expected_amount, variance_amount, notes, counted_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [orgId, payload.shiftId, money(counted), money(expected), money(counted.minus(expected)), payload.notes || null, actorUserId || null]);
  return rows[0];
}
async function createCashDeposit({ orgId, actorUserId, payload }) {
  if (D(payload?.amount || 0).lt(0)) throw new AppError(400, 'amount must be non-negative');
  const { rows } = await pool.query(`INSERT INTO pos_cash_deposits(organization_id, shift_id, amount, reference, status, created_by) VALUES($1,$2,$3,$4,'prepared',$5) RETURNING *`, [orgId, payload.shiftId || null, money(payload.amount), payload.reference || null, actorUserId || null]);
  return rows[0];
}

async function registerDevice({ orgId, payload }) {
  if (!payload?.deviceCode) throw new AppError(400, 'deviceCode is required');
  const { rows } = await pool.query(`INSERT INTO pos_devices(organization_id, store_id, register_id, device_code, device_name, status, last_seen_at) VALUES($1,$2,$3,$4,$5,'active',now()) ON CONFLICT (organization_id, device_code) DO UPDATE SET store_id=EXCLUDED.store_id, register_id=EXCLUDED.register_id, device_name=EXCLUDED.device_name, status='active', last_seen_at=now() RETURNING *`, [orgId, payload.storeId || null, payload.registerId || null, payload.deviceCode, payload.deviceName || null]);
  return rows[0];
}
async function syncOfflineBatch({ orgId, actorUserId, payload }) {
  if (!payload?.batchNo) throw new AppError(400, 'batchNo is required');
  const { rows: devRows } = payload.deviceCode ? await pool.query(`SELECT id FROM pos_devices WHERE organization_id=$1 AND device_code=$2`, [orgId, payload.deviceCode]) : { rows: [] };
  const { rows } = await pool.query(`INSERT INTO pos_sync_batches(organization_id, device_id, batch_no, status, metadata) VALUES($1,$2,$3,'received',$4) ON CONFLICT (organization_id, batch_no) DO UPDATE SET metadata=EXCLUDED.metadata RETURNING *`, [orgId, devRows[0]?.id || null, payload.batchNo, payload.metadata || {}]);
  return { batch: rows[0], processedCount: 0, note: 'Batch recorded. Offline sale replay should call POS sale creation with idempotency keys.' };
}
async function syncStatus({ orgId, batchId }) {
  const { rows } = await pool.query(`SELECT * FROM pos_sync_batches WHERE organization_id=$1 AND id=$2`, [orgId, batchId]);
  if (!rows.length) throw new AppError(404, 'Sync batch not found');
  return rows[0];
}

async function initializePayment({ orgId, payload }) {
  const currency = payload.currencyCode || (await pool.query(`SELECT base_currency_code FROM organizations WHERE id=$1`, [orgId])).rows[0]?.base_currency_code || 'GHS';
  const reference = payload.reference || `PAY-${Date.now()}`;
  const { rows } = await pool.query(`INSERT INTO commerce_payment_transactions(organization_id, provider_id, reference, direction, amount, currency_code, status, sale_id, order_id, provider_payload) VALUES($1,$2,$3,'inbound',$4,$5,'pending',$6,$7,$8) ON CONFLICT (organization_id, reference) DO UPDATE SET updated_at=now() RETURNING *`, [orgId, payload.providerId || null, reference, money(payload.amount || 0), currency, payload.saleId || null, payload.orderId || null, payload.metadata || {}]);
  return rows[0];
}
async function confirmPayment({ orgId, payload }) {
  const { rows } = await pool.query(`UPDATE commerce_payment_transactions SET status=COALESCE($3,status), provider_payload=provider_payload || $4::jsonb, updated_at=now() WHERE organization_id=$1 AND reference=$2 RETURNING *`, [orgId, payload.reference, payload.status || 'captured', JSON.stringify(payload.providerPayload || {})]);
  if (!rows.length) throw new AppError(404, 'Payment transaction not found');
  return rows[0];
}
async function refundPayment({ orgId, payload }) {
  return initializePayment({ orgId, payload: { ...payload, reference: payload.reference || `REF-${Date.now()}`, amount: payload.amount || 0, metadata: { refund: true, ...(payload.metadata || {}) } } });
}
async function recordPaymentWebhook({ orgId, provider, payload, signatureValid = null }) {
  const { rows } = await pool.query(`INSERT INTO commerce_payment_webhook_events(organization_id, provider, provider_event_id, event_type, payload, signature_valid) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (provider, provider_event_id) DO UPDATE SET payload=EXCLUDED.payload RETURNING *`, [orgId || null, provider, payload?.id || payload?.eventId || null, payload?.event || payload?.type || null, payload || {}, signatureValid]);
  return rows[0];
}
async function paymentStatus({ orgId, paymentId }) {
  const { rows } = await pool.query(`SELECT * FROM commerce_payment_transactions WHERE organization_id=$1 AND id=$2`, [orgId, paymentId]);
  if (!rows.length) throw new AppError(404, 'Payment transaction not found');
  return rows[0];
}

async function categorySalesReport({ orgId, query = {} }) {
  const from = query.from || '1900-01-01'; const to = query.to || '2999-12-31';
  const { rows } = await pool.query(`SELECT COALESCE(c.name,'Uncategorised') AS category, COALESCE(SUM(l.quantity),0)::text quantity, COALESCE(SUM(l.total_amount),0)::text sales FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id JOIN inventory_items i ON i.id=l.item_id LEFT JOIN item_categories c ON c.id=i.category_id WHERE l.organization_id=$1 AND s.sale_date BETWEEN $2 AND $3 AND s.status NOT IN ('voided') GROUP BY c.name ORDER BY sales::numeric DESC`, [orgId, from, to]);
  return { from, to, data: rows };
}
async function grossMarginReport(args) { return productSalesReport(args); }
async function refundsReturnsReport({ orgId, query = {} }) {
  const { rows } = await pool.query(`SELECT s.sale_no, r.amount::text, r.status, r.reason, r.created_at FROM pos_refunds r JOIN pos_sales s ON s.id=r.sale_id WHERE r.organization_id=$1 ORDER BY r.created_at DESC LIMIT 200`, [orgId]);
  return { data: rows };
}
async function discountsReport({ orgId, query = {} }) {
  const from = query.from || '1900-01-01'; const to = query.to || '2999-12-31';
  const { rows } = await pool.query(`SELECT sale_date, COUNT(*)::int sale_count, COALESCE(SUM(discount_amount),0)::text discount_amount FROM pos_sales WHERE organization_id=$1 AND sale_date BETWEEN $2 AND $3 AND discount_amount > 0 GROUP BY sale_date ORDER BY sale_date`, [orgId, from, to]);
  return { from, to, data: rows };
}
async function customerSalesReport({ orgId, query = {} }) {
  const { rows } = await pool.query(`SELECT bp.name AS customer_name, COUNT(s.id)::int sale_count, COALESCE(SUM(s.total_amount),0)::text total_sales FROM pos_sales s LEFT JOIN business_partners bp ON bp.id=s.customer_id WHERE s.organization_id=$1 GROUP BY bp.name ORDER BY total_sales::numeric DESC LIMIT 200`, [orgId]);
  return { data: rows };
}
async function ecommerceOrdersReport({ orgId, query = {} }) {
  const { rows } = await pool.query(`SELECT status, COUNT(*)::int order_count, COALESCE(SUM(total_amount),0)::text total_amount FROM commerce_orders WHERE organization_id=$1 GROUP BY status ORDER BY status`, [orgId]);
  return { data: rows };
}


async function catalogPrices({ orgId, query = {} }) {
  query = cleanQuery(query);
  const params = [orgId];
  const where = [`pl.organization_id=$1`, `pli.status='active'`, `(pli.effective_to IS NULL OR pli.effective_to >= CURRENT_DATE)`];
  let n = 2;
  if (query.priceListId) { where.push(`pl.id=$${n++}`); params.push(query.priceListId); }
  if (query.itemId) { where.push(`pli.item_id=$${n++}`); params.push(query.itemId); }
  if (query.q) { where.push(`(i.sku ILIKE $${n} OR i.name ILIKE $${n})`); params.push(`%${query.q}%`); n++; }
  const { rows } = await pool.query(
    `SELECT pli.*, pl.code AS price_list_code, pl.name AS price_list_name, i.sku, i.name AS item_name
       FROM commerce_price_list_items pli
       JOIN commerce_price_lists pl ON pl.id=pli.price_list_id
       JOIN inventory_items i ON i.id=pli.item_id
      WHERE ${where.join(' AND ')}
      ORDER BY pl.is_default DESC, pl.name, i.sku LIMIT 250`, params);
  return rowList(rows);
}
async function updatePriceList({ orgId, priceListId, payload }) {
  payload = normalizePayload(payload || {});
  const { rows } = await pool.query(
    `UPDATE commerce_price_lists SET name=COALESCE($3,name), currency_code=COALESCE($4,currency_code), is_default=COALESCE($5,is_default), status=COALESCE($6,status), updated_at=now()
      WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, priceListId, payload.name ?? null, payload.currencyCode ?? null, payload.isDefault ?? null, payload.status ?? null]);
  if (!rows.length) throw new AppError(404, 'Price list not found');
  return ok(rows[0]);
}
async function listShifts({ orgId, query = {} }) {
  query = cleanQuery(query);
  const params = [orgId]; const where = [`sh.organization_id=$1`]; let n=2;
  if (query.registerId) { where.push(`sh.register_id=$${n++}`); params.push(query.registerId); }
  if (query.storeId) { where.push(`sh.store_id=$${n++}`); params.push(query.storeId); }
  if (query.status) { where.push(`sh.status=$${n++}`); params.push(query.status); }
  const limit = Math.min(Number(query.limit || 100), 250);
  const { rows } = await pool.query(
    `SELECT sh.*, sh.id::text AS shift_no, r.code AS register_code, r.name AS register_name, st.code AS store_code, st.name AS store_name
       FROM pos_shifts sh JOIN pos_registers r ON r.id=sh.register_id JOIN pos_stores st ON st.id=sh.store_id
      WHERE ${where.join(' AND ')} ORDER BY sh.opened_at DESC LIMIT ${limit}`, params);
  return rowList(rows);
}
async function listDevices({ orgId, query = {} }) {
  query = cleanQuery(query);
  const params = [orgId]; const where = [`d.organization_id=$1`]; let n=2;
  if (query.registerId) { where.push(`d.register_id=$${n++}`); params.push(query.registerId); }
  if (query.storeId) { where.push(`d.store_id=$${n++}`); params.push(query.storeId); }
  const { rows } = await pool.query(
    `SELECT d.*, r.code AS register_code, r.name AS register_name, s.code AS store_code, s.name AS store_name
       FROM pos_devices d LEFT JOIN pos_registers r ON r.id=d.register_id LEFT JOIN pos_stores s ON s.id=d.store_id
      WHERE ${where.join(' AND ')} ORDER BY d.last_seen_at DESC NULLS LAST, d.device_code`, params);
  return rowList(rows);
}
function normalizePaymentProviderType(value) {
  const raw = String(value || 'manual').toLowerCase();
  if (raw === 'manual_terminal') return 'bank_terminal';
  if (['manual', 'paystack', 'flutterwave', 'hubtel', 'theteller', 'bank_terminal'].includes(raw)) return raw;
  return 'manual';
}

async function listPaymentProviders({ orgId }) {
  const { rows } = await pool.query(
    `SELECT id, organization_id, code AS provider, code, name AS display_name, name, provider_type, status, config_json AS config, created_at, updated_at
       FROM commerce_payment_providers
      WHERE organization_id=$1
      ORDER BY provider_type, name`,
    [orgId]
  );
  return rowList(rows);
}
async function savePaymentProvider({ orgId, payload }) {
  payload = normalizePayload(payload || {});
  const provider = payload.provider || payload.code || payload.providerType;
  if (!provider) throw new AppError(400, 'provider is required');
  const providerType = normalizePaymentProviderType(payload.providerType || provider);
  const displayName = payload.displayName || payload.name || provider;
  const { rows } = await pool.query(
    `INSERT INTO commerce_payment_providers(organization_id, code, name, provider_type, status, config_json)
     VALUES($1,$2,$3,$4,COALESCE($5,'active'),COALESCE($6,'{}'::jsonb))
     ON CONFLICT (organization_id, code) DO UPDATE SET
       name=EXCLUDED.name,
       provider_type=EXCLUDED.provider_type,
       status=EXCLUDED.status,
       config_json=commerce_payment_providers.config_json || EXCLUDED.config_json,
       updated_at=now()
     RETURNING id, organization_id, code AS provider, code, name AS display_name, name, provider_type, status, config_json AS config, created_at, updated_at`,
    [orgId, provider, displayName, providerType, payload.status || null, payload.config || {}]
  );
  return ok(rows[0]);
}
async function listPaymentMethods({ orgId }) {
  const { rows } = await pool.query(`SELECT id, code, name, description, status, created_at FROM payment_methods WHERE organization_id=$1 AND status='active' ORDER BY code`, [orgId]);
  return rowList(rows);
}
async function listAccountingProfiles({ orgId }) {
  const { rows } = await pool.query(`SELECT * FROM pos_accounting_profiles WHERE organization_id=$1 ORDER BY is_default DESC, name`, [orgId]);
  return rowList(rows);
}
async function saveAccountingProfile({ orgId, payload }) {
  payload = normalizePayload(payload || {});
  if (!payload.name) throw new AppError(400, 'name is required');
  const { rows } = await pool.query(
    `INSERT INTO pos_accounting_profiles(organization_id, name, is_default, default_cash_account_id, sales_revenue_account_id, discount_account_id, sales_returns_account_id, cogs_account_id, inventory_account_id, cash_over_short_account_id, status)
     VALUES($1,$2,COALESCE($3,false),$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'active'))
     ON CONFLICT (organization_id, name) DO UPDATE SET is_default=EXCLUDED.is_default, default_cash_account_id=EXCLUDED.default_cash_account_id, sales_revenue_account_id=EXCLUDED.sales_revenue_account_id, discount_account_id=EXCLUDED.discount_account_id, sales_returns_account_id=EXCLUDED.sales_returns_account_id, cogs_account_id=EXCLUDED.cogs_account_id, inventory_account_id=EXCLUDED.inventory_account_id, cash_over_short_account_id=EXCLUDED.cash_over_short_account_id, status=EXCLUDED.status, updated_at=now()
     RETURNING *`, [orgId, payload.name, !!payload.isDefault, payload.defaultCashAccountId || null, payload.salesRevenueAccountId || null, payload.discountAccountId || null, payload.salesReturnsAccountId || null, payload.cogsAccountId || null, payload.inventoryAccountId || null, payload.cashOverShortAccountId || null, payload.status || 'active']);
  return ok(rows[0]);
}
async function listCashMovements({ orgId, query = {} }) {
  query = cleanQuery(query);
  const params=[orgId]; const where=[`m.organization_id=$1`]; let n=2;
  if (query.shiftId) { where.push(`m.shift_id=$${n++}`); params.push(query.shiftId); }
  const { rows } = await pool.query(`SELECT m.* FROM pos_cash_movements m WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT 200`, params);
  return rowList(rows);
}
async function listCashCounts({ orgId, query = {} }) {
  query = cleanQuery(query);
  const params=[orgId]; const where=[`organization_id=$1`]; let n=2;
  if (query.shiftId) { where.push(`shift_id=$${n++}`); params.push(query.shiftId); }
  const { rows } = await pool.query(`SELECT * FROM pos_cash_counts WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params);
  return rowList(rows);
}
async function listCashDeposits({ orgId, query = {} }) {
  query = cleanQuery(query);
  const params=[orgId]; const where=[`organization_id=$1`]; let n=2;
  if (query.shiftId) { where.push(`shift_id=$${n++}`); params.push(query.shiftId); }
  const { rows } = await pool.query(`SELECT * FROM pos_cash_deposits WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params);
  return rowList(rows);
}
async function cashShiftSummary({ orgId, query = {} }) {
  query = cleanQuery(query);
  if (query.shiftId) return ok(await shiftSummary({ orgId, shiftId: query.shiftId }));
  return listShifts({ orgId, query: { status: 'open', limit: query.limit || 50 } });
}
async function completeSale({ orgId, actorUserId = null, saleId }) {
  return withTx(async (client) => {
    const { rows } = await client.query(`UPDATE pos_sales SET status='completed', updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='draft' RETURNING *`, [orgId, saleId]);
    let sale = rows[0] || null;
    if (!sale) {
      const current = await client.query(`SELECT * FROM pos_sales WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, saleId]);
      sale = current.rows[0] || null;
      if (!sale) throw new AppError(404, 'POS sale not found');
      if (!['completed','posted'].includes(sale.status)) throw new AppError(409, 'Sale cannot be completed from current status');
    }
    await fiscalizationSvc.autoPrepareForSource({ db: client, orgId, actorUserId, sourceType: 'pos_sale', sourceId: saleId });
    return ok(sale);
  });
}
async function emailReceipt({ orgId, saleId, payload = {} }) {
  const receipt = await receiptData({ orgId, saleId });
  return ok({ deliveryStatus: 'queued', channel: 'email', recipient: payload.email || null, receipt });
}
async function whatsappReceipt({ orgId, saleId, payload = {} }) {
  const receipt = await receiptData({ orgId, saleId });
  return ok({ deliveryStatus: 'queued', channel: 'whatsapp', recipient: payload.phone || null, receipt });
}
async function listReturns({ orgId, query = {} }) {
  query = cleanQuery(query);
  const params=[orgId]; const where=[`r.organization_id=$1`]; let n=2;
  if (query.status) { where.push(`r.status=$${n++}`); params.push(query.status); }
  const { rows } = await pool.query(`SELECT r.*, s.sale_no FROM pos_return_authorizations r JOIN pos_sales s ON s.id=r.sale_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 200`, params);
  return rowList(rows);
}
async function listRefunds({ orgId, query = {} }) {
  query = cleanQuery(query);
  const params=[orgId]; const where=[`r.organization_id=$1`]; let n=2;
  if (query.status) { where.push(`r.status=$${n++}`); params.push(query.status); }
  const { rows } = await pool.query(`SELECT r.*, s.sale_no FROM pos_refunds r JOIN pos_sales s ON s.id=r.sale_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 200`, params);
  return rowList(rows);
}
async function getOrder({ orgId, orderId }) {
  const { rows } = await pool.query(`SELECT o.*, bp.name AS customer_name FROM commerce_orders o LEFT JOIN business_partners bp ON bp.id=o.customer_id WHERE o.organization_id=$1 AND o.id=$2`, [orgId, orderId]);
  if (!rows.length) throw new AppError(404, 'Order not found');
  const { rows: lines } = await pool.query(`SELECT l.*, i.sku, i.name AS item_name FROM commerce_order_lines l JOIN inventory_items i ON i.id=l.item_id WHERE l.organization_id=$1 AND l.order_id=$2 ORDER BY l.line_no`, [orgId, orderId]);
  return ok({ ...rows[0], lines });
}
async function createCart({ orgId, actorUserId, payload = {} }) {
  payload = normalizePayload(payload || {});
  if (Array.isArray(payload.lines) && payload.lines.length) return createOrder({ orgId, actorUserId, payload: { ...payload, status: 'cart' } });
  const orderNo = payload.orderNo || `CART-${Date.now()}`;
  const currency = payload.currencyCode || (await pool.query(`SELECT base_currency_code FROM organizations WHERE id=$1`, [orgId])).rows[0]?.base_currency_code || 'GHS';
  const { rows } = await pool.query(`INSERT INTO commerce_orders(organization_id, order_no, channel_code, customer_id, status, order_date, currency_code, tax_inclusive, created_by, metadata) VALUES($1,$2,COALESCE($3,'web'),$4,'cart',COALESCE($5::date,CURRENT_DATE),$6,COALESCE($7,false),$8,$9) RETURNING *`, [orgId, orderNo, payload.channelCode || null, payload.customerId || null, payload.orderDate || null, currency, !!payload.taxInclusive, actorUserId || null, payload.metadata || {}]);
  return ok(rows[0]);
}
async function addCartItem({ orgId, cartId, payload = {} }) {
  payload = normalizePayload(payload);
  if (!payload.itemId) throw new AppError(400, 'itemId is required');
  const { rows: orderRows } = await pool.query(`SELECT * FROM commerce_orders WHERE organization_id=$1 AND id=$2`, [orgId, cartId]);
  if (!orderRows.length) throw new AppError(404, 'Cart not found');
  const existing = await getOrder({ orgId, orderId: cartId });
  const lines = [...(existing.lines || []).map(l => ({ itemId: l.itemId, quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: l.discountAmount, taxCodeId: l.taxCodeId })), payload];
  await pool.query(`DELETE FROM commerce_order_lines WHERE organization_id=$1 AND order_id=$2`, [orgId, cartId]);
  const calc = await withTx(async (client)=>calculateSale(client, orgId, { ...orderRows[0], taxInclusive: orderRows[0].tax_inclusive, lines }));
  for (const l of calc.lines) await pool.query(`INSERT INTO commerce_order_lines(organization_id, order_id, line_no, item_id, description, quantity, unit_price, discount_amount, taxable_amount, tax_amount, total_amount, tax_code_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [orgId, cartId, l.lineNo, l.itemId, l.item.name, qty(l.quantity), money(l.unitPrice), money(l.discountAmount), money(l.taxableAmount), money(l.taxAmount), money(l.totalAmount), l.taxCodeId]);
  await pool.query(`UPDATE commerce_orders SET subtotal_amount=$3, discount_amount=$4, tax_amount=$5, total_amount=$6, updated_at=now() WHERE organization_id=$1 AND id=$2`, [orgId, cartId, money(calc.subtotalAmount), money(calc.discountAmount), money(calc.taxAmount), money(calc.totalAmount)]);
  return getOrder({ orgId, orderId: cartId });
}
async function checkout({ orgId, actorUserId, payload = {} }) {
  payload = normalizePayload(payload);
  if (payload.cartId) {
    const { rows } = await pool.query(`UPDATE commerce_orders SET status='pending_payment', updated_at=now() WHERE organization_id=$1 AND id=$2 AND status IN ('cart','draft','pending_payment') RETURNING *`, [orgId, payload.cartId]);
    if (!rows.length) throw new AppError(404, 'Cart not found or cannot be checked out');
    return ok(rows[0]);
  }
  return createOrder({ orgId, actorUserId, payload });
}
async function cancelOrder({ orgId, orderId, payload = {} }) {
  const { rows } = await pool.query(`UPDATE commerce_orders SET status='cancelled', metadata=metadata || $3::jsonb, updated_at=now() WHERE organization_id=$1 AND id=$2 AND status NOT IN ('fulfilled','cancelled') RETURNING *`, [orgId, orderId, JSON.stringify({ cancelReason: payload.reason || null })]);
  if (!rows.length) throw new AppError(404, 'Order not found or cannot be cancelled');
  return ok(rows[0]);
}
async function refundOrder({ orgId, orderId, payload = {} }) {
  const { rows } = await pool.query(`UPDATE commerce_orders SET status='refunded', metadata=metadata || $3::jsonb, updated_at=now() WHERE organization_id=$1 AND id=$2 AND status IN ('paid','fulfilled') RETURNING *`, [orgId, orderId, JSON.stringify({ refund: payload || {} })]);
  if (!rows.length) throw new AppError(404, 'Order not found or cannot be refunded');
  return ok(rows[0]);
}
async function shiftSummaryReport({ orgId, query = {} }) {
  query = cleanQuery(query);
  if (query.shiftId) return ok(await shiftSummary({ orgId, shiftId: query.shiftId }));
  const shifts = await listShifts({ orgId, query: { ...query, limit: query.limit || 100 } });
  return shifts;
}
async function cashierSalesReport({ orgId, query = {} }) {
  query = cleanQuery(query);
  const from = query.from || '1900-01-01'; const to = query.to || '2999-12-31';
  const { rows } = await pool.query(`SELECT u.id AS cashier_id, COALESCE(u.full_name,u.email::text,'Unknown') AS cashier_name, COUNT(s.id)::int sale_count, COALESCE(SUM(s.total_amount),0)::text total_sales FROM pos_sales s LEFT JOIN users u ON u.id=s.cashier_user_id WHERE s.organization_id=$1 AND s.sale_date BETWEEN $2 AND $3 AND s.status NOT IN ('voided') GROUP BY u.id, u.full_name, u.email ORDER BY total_sales::numeric DESC`, [orgId, from, to]);
  return rowList(rows, { from, to });
}

function wrap(fn) {
  return async (args = {}) => ok(await fn({ ...args, query: cleanQuery(args.query), payload: normalizePayload(args.payload || {}) }));
}
module.exports = {
  listProducts: wrap(listProducts), getProduct: wrap(getProduct), listCustomers: wrap(listCustomers), customerPurchaseHistory: wrap(customerPurchaseHistory),
  listPriceLists: wrap(listPriceLists), createPriceList: wrap(createPriceList), updatePriceList: wrap(updatePriceList), upsertPriceListItem: wrap(upsertPriceListItem), catalogPrices: wrap(catalogPrices),
  listStores: wrap(listStores), createStore: wrap(createStore), updateStore: wrap(updateStore), listRegisters: wrap(listRegisters), createRegister: wrap(createRegister), updateRegister: wrap(updateRegister),
  openShift: wrap(openShift), closeShift: wrap(closeShift), listShifts: wrap(listShifts), shiftSummary: wrap(shiftSummary), recordCashMovement: wrap(recordCashMovement),
  listCashMovements: wrap(listCashMovements), listCashCounts: wrap(listCashCounts), listCashDeposits: wrap(listCashDeposits), cashShiftSummary: wrap(cashShiftSummary),
  taxPreview: wrap(taxPreview), createSale: wrap(createSale), completeSale: wrap(completeSale), listSales: wrap(listSales), getSale: wrap(getSale), postSale: wrap(postSale), voidSale: wrap(voidSale), refundSale: wrap(refundSale), receiptData: wrap(receiptData), emailReceipt: wrap(emailReceipt), whatsappReceipt: wrap(whatsappReceipt),
  createOrder: wrap(createOrder), listOrders: wrap(listOrders), getOrder: wrap(getOrder), markOrderPaid: wrap(markOrderPaid), fulfillOrderToSale: wrap(fulfillOrderToSale), createCart: wrap(createCart), addCartItem: wrap(addCartItem), checkout: wrap(checkout), cancelOrder: wrap(cancelOrder), refundOrder: wrap(refundOrder),
  createReturn: wrap(createReturn), listReturns: wrap(listReturns), approveReturn: wrap(approveReturn), rejectReturn: wrap(rejectReturn), receiveReturn: wrap(receiveReturn),
  createRefund: wrap(createRefund), listRefunds: wrap(listRefunds), approveRefund: wrap(approveRefund), postRefund: wrap(postRefund),
  listPromotions: wrap(listPromotions), createPromotion: wrap(createPromotion), updatePromotion: wrap(updatePromotion), applyPromotionPreview: wrap(applyPromotionPreview),
  listCoupons: wrap(listCoupons), createCoupon: wrap(createCoupon), validateCoupon: wrap(validateCoupon),
  getLoyalty: wrap(getLoyalty), adjustLoyalty: wrap(adjustLoyalty), getStoreCredit: wrap(getStoreCredit), adjustStoreCredit: wrap(adjustStoreCredit),
  recordCashCount: wrap(recordCashCount), createCashDeposit: wrap(createCashDeposit), registerDevice: wrap(registerDevice), listDevices: wrap(listDevices), syncOfflineBatch: wrap(syncOfflineBatch), syncStatus: wrap(syncStatus),
  initializePayment: wrap(initializePayment), confirmPayment: wrap(confirmPayment), refundPayment: wrap(refundPayment), recordPaymentWebhook: wrap(recordPaymentWebhook), paymentStatus: wrap(paymentStatus),
  listPaymentMethods: wrap(listPaymentMethods), listPaymentProviders: wrap(listPaymentProviders), savePaymentProvider: wrap(savePaymentProvider), listAccountingProfiles: wrap(listAccountingProfiles), saveAccountingProfile: wrap(saveAccountingProfile),
  dailySalesReport: wrap(dailySalesReport), productSalesReport: wrap(productSalesReport), paymentReconciliationReport: wrap(paymentReconciliationReport), taxSummaryReport: wrap(taxSummaryReport),
  categorySalesReport: wrap(categorySalesReport), grossMarginReport: wrap(grossMarginReport), refundsReturnsReport: wrap(refundsReturnsReport), discountsReport: wrap(discountsReport), customerSalesReport: wrap(customerSalesReport), ecommerceOrdersReport: wrap(ecommerceOrdersReport), shiftSummaryReport: wrap(shiftSummaryReport), cashierSalesReport: wrap(cashierSalesReport)
};
