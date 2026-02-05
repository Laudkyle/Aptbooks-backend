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
async function getCustomerReceiptById(orgId, receiptId) {
  const { rows } = await pool.query(
    `SELECT 
      cr.*,
      bp.name as customer_name,
      bp.email as customer_email,
      bp.phone as customer_phone,
      addr.label as customer_address_label,
      addr.line1 as customer_address_line1,
      addr.line2 as customer_address_line2,
      addr.city as customer_address_city,
      addr.region as customer_address_region,
      addr.postal_code as customer_address_postal_code,
      addr.country as customer_address_country,
      pm.name as payment_method_name,
      coa.name as cash_account_name,
      coa.code as cash_account_code
     FROM customer_receipts cr
     LEFT JOIN business_partners bp ON cr.customer_id = bp.id
     LEFT JOIN business_partner_addresses addr ON bp.id = addr.partner_id AND addr.is_primary = TRUE
     LEFT JOIN payment_methods pm ON cr.payment_method_id = pm.id
     LEFT JOIN chart_of_accounts coa ON cr.cash_account_id = coa.id
     WHERE cr.organization_id=$1 AND cr.id=$2`,
    [orgId, receiptId]
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
  const where = ["cr.organization_id=$1"];
  let i = 2;

  if (query?.status) { 
    where.push(`cr.status=$${i++}`); 
    params.push(query.status); 
  }
  if (query?.customerId) { 
    where.push(`cr.customer_id=$${i++}`); 
    params.push(query.customerId); 
  }

  const { rows } = await pool.query(
    `SELECT 
      cr.*,
      bp.name as customer_name,
      addr.line1 as customer_address_line1,
      addr.city as customer_address_city,
      addr.country as customer_address_country
     FROM customer_receipts cr
     LEFT JOIN business_partners bp ON cr.customer_id = bp.id
     LEFT JOIN business_partner_addresses addr ON bp.id = addr.partner_id AND addr.is_primary = TRUE
     WHERE ${where.join(" AND ")}
     ORDER BY cr.receipt_date DESC, cr.created_at DESC`,
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
