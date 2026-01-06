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
      amount_total, currency_code, fx_rate, status, memo
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'draft',$9)
    RETURNING *
    `,
    [orgId, customerId, receiptNo, receiptDate, paymentMethodId || null, cashAccountId, amountTotal, currencyCode, memo || null]
  );
  return rows[0];
}

async function upsertAllocation(client, { customerReceiptId, invoiceId, amountApplied }) {
  await client.query(
    `
    INSERT INTO customer_receipt_allocations(customer_receipt_id, invoice_id, amount_applied)
    VALUES ($1,$2,$3)
    ON CONFLICT (customer_receipt_id, invoice_id)
    DO UPDATE SET amount_applied=EXCLUDED.amount_applied
    `,
    [customerReceiptId, invoiceId, amountApplied]
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

  if (query?.status) { where.push(`status=$${i++}`); params.push(query.status); }
  if (query?.customerId) { where.push(`customer_id=$${i++}`); params.push(query.customerId); }

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
  getCustomerReceiptById,
  getAllocations,
  listCustomerReceipts
};
