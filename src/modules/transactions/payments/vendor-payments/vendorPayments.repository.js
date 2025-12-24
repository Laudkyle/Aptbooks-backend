const { pool } = require("../../../../db/pool");

async function nextPaymentNo(client, orgId) {
  await client.query(
    `INSERT INTO vendor_payment_sequences(organization_id, next_no)
     VALUES ($1, 1) ON CONFLICT (organization_id) DO NOTHING`,
    [orgId]
  );

  const { rows } = await client.query(
    `UPDATE vendor_payment_sequences SET next_no = next_no + 1, updated_at=NOW()
     WHERE organization_id=$1 RETURNING next_no`,
    [orgId]
  );

  const no = BigInt(rows[0].next_no) - 1n;
  return `VPAY-${String(no).padStart(6, "0")}`;
}

async function insertVendorPayment(client, { orgId, vendorId, paymentNo, paymentDate, paymentMethodId, cashAccountId, amountTotal }) {
  const { rows } = await client.query(
    `
    INSERT INTO vendor_payments(
      organization_id, vendor_id, payment_no, payment_date,
      currency_code, fx_rate, payment_method_id, cash_account_id,
      amount_total, status
    )
    VALUES ($1,$2,$3,$4,'GHS',1,$5,$6,$7,'draft')
    RETURNING *
    `,
    [orgId, vendorId, paymentNo, paymentDate, paymentMethodId || null, cashAccountId, amountTotal]
  );
  return rows[0];
}

async function upsertAllocation(client, { vendorPaymentId, billId, amountApplied }) {
  await client.query(
    `
    INSERT INTO vendor_payment_allocations(vendor_payment_id, bill_id, amount_applied)
    VALUES ($1,$2,$3)
    ON CONFLICT (vendor_payment_id, bill_id)
    DO UPDATE SET amount_applied = EXCLUDED.amount_applied
    `,
    [vendorPaymentId, billId, amountApplied]
  );
}

async function getVendorPaymentById(orgId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM vendor_payments WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  );
  return rows[0] || null;
}

async function getAllocations(vendorPaymentId) {
  const { rows } = await pool.query(
    `SELECT * FROM vendor_payment_allocations WHERE vendor_payment_id=$1 ORDER BY created_at ASC`,
    [vendorPaymentId]
  );
  return rows;
}

async function listVendorPayments({ orgId, query }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;

  if (query?.status) { where.push(`status=$${i++}`); params.push(query.status); }
  if (query?.vendorId) { where.push(`vendor_id=$${i++}`); params.push(query.vendorId); }

  const { rows } = await pool.query(
    `SELECT * FROM vendor_payments WHERE ${where.join(" AND ")} ORDER BY payment_date DESC, created_at DESC`,
    params
  );
  return rows;
}

module.exports = { nextPaymentNo, insertVendorPayment, upsertAllocation, getVendorPaymentById, getAllocations, listVendorPayments };
