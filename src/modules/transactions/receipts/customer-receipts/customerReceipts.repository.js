const { pool } = require("../../../../db/pool"); 

async function nextReceiptNo(client, orgId) {
  await client.query(
    `INSERT INTO customer_receipt_sequences(organization_id, next_no)
     VALUES ($1, 1) ON CONFLICT (organization_id) DO NOTHING`,
    [orgId]
  ); 

  const { rows } = await client.query(
    `UPDATE customer_receipt_sequences
     SET next_no = next_no + 1, updated_at=NOW()
     WHERE organization_id=$1
     RETURNING next_no`,
    [orgId]
  ); 

  const no = BigInt(rows[0].next_no) - 1n; 
  return `RCPT-${String(no).padStart(6, "0")}`; 
}

async function insertCustomerReceipt(client, {
  orgId,
  customerId,
  receiptNo,
  receiptDate,
  paymentMethodId,
  cashAccountId,
  amountTotal,
  currencyCode,
  memo
}) {
  const { rows } = await client.query(
    `
    INSERT INTO customer_receipts(
      organization_id, customer_id, receipt_no, receipt_date,
      payment_method_id, cash_account_id,
      amount_total, currency_code, fx_rate, status, memo,
      unapplied_amount, discount_total, settlement_total
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'draft',$9,0,0,0)
    RETURNING *
    `,
    [orgId, customerId, receiptNo, receiptDate, paymentMethodId || null, cashAccountId, amountTotal, currencyCode, memo || null]
  ); 
  return rows[0]; 
}

async function upsertAllocation(client, { customerReceiptId, invoiceId, amountApplied, discountTaken }) {
  await client.query(
    `
    INSERT INTO customer_receipt_allocations(customer_receipt_id, invoice_id, amount_applied, discount_taken)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (customer_receipt_id, invoice_id)
    DO UPDATE SET amount_applied=EXCLUDED.amount_applied, discount_taken=EXCLUDED.discount_taken
    `,
    [customerReceiptId, invoiceId, amountApplied, discountTaken || "0.00"]
  ); 
}

async function deleteAllocations(client, customerReceiptId) {
  await client.query(
    `DELETE FROM customer_receipt_allocations WHERE customer_receipt_id=$1`,
    [customerReceiptId]
  ); 
}

async function recordAllocationEvent(client, { orgId, customerReceiptId, actorUserId, action, before, after }) {
  await client.query(
    `
    INSERT INTO customer_receipt_allocation_events(
      organization_id, customer_receipt_id, actor_user_id, action, before, after
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [orgId, customerReceiptId, actorUserId || null, action, before || null, after || null]
  ); 
}

async function getCustomerReceiptById(orgId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM customer_receipts WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  ); 
  return rows[0] || null; 
}

async function getAllocations(customerReceiptId) {
  const { rows } = await pool.query(
    `SELECT * FROM customer_receipt_allocations WHERE customer_receipt_id=$1 ORDER BY created_at ASC`,
    [customerReceiptId]
  ); 
  return rows; 
}

async function listCustomerReceipts({ orgId, query }) {
  const params = [orgId]; 
  const where = ["organization_id=$1"]; 
  let i = 2; 

  if (query?.status) { where.push(`status=$${i++}`);  params.push(query.status);  }
  if (query?.customerId) { where.push(`customer_id=$${i++}`);  params.push(query.customerId);  }

  const { rows } = await pool.query(
    `SELECT * FROM customer_receipts WHERE ${where.join(" AND ")}
     ORDER BY receipt_date DESC, created_at DESC`,
    params
  ); 
  return rows; 
}

module.exports = {
  nextReceiptNo,
  insertCustomerReceipt,
  upsertAllocation,
  deleteAllocations,
  recordAllocationEvent,
  getCustomerReceiptById,
  getAllocations,
  listCustomerReceipts
}; 
