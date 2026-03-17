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

async function insertVendorPayment(client, { orgId, vendorId, paymentNo, paymentDate, paymentMethodId, cashAccountId, amountTotal, currencyCode }) {
  const { rows } = await client.query(
    `
    INSERT INTO vendor_payments(
      organization_id, vendor_id, payment_no, payment_date,
      currency_code, fx_rate, payment_method_id, cash_account_id,
      amount_total, status
    )
    VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,'draft')
    RETURNING *
    `,
    [orgId, vendorId, paymentNo, paymentDate, currencyCode, paymentMethodId || null, cashAccountId, amountTotal]
  );
  return rows[0];
}

async function upsertAllocation(client, { vendorPaymentId, billId, amountApplied, discountTaken }) {
  await client.query(
    `
    INSERT INTO vendor_payment_allocations(vendor_payment_id, bill_id, amount_applied, discount_taken)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (vendor_payment_id, bill_id)
    DO UPDATE SET amount_applied=EXCLUDED.amount_applied, discount_taken=EXCLUDED.discount_taken
    `,
    [vendorPaymentId, billId, amountApplied, discountTaken || "0.00"]
  );
}

async function listVendorPayments({ orgId, query }) {
  const params = [orgId];
  const where = ["vp.organization_id=$1"];
  let i = 2;

  if (query?.status) { 
    where.push(`vp.status=$${i++}`); 
    params.push(query.status); 
  }
  if (query?.vendor_id) { 
    where.push(`vp.vendor_id=$${i++}`); 
    params.push(query.vendor_id); 
  }

  const { rows } = await pool.query(
    `SELECT 
      vp.*,
      bp.name as vendor_name,
      addr.line1 as vendor_address_line1,
      addr.city as vendor_address_city,
      addr.country as vendor_address_country,
      pm.name as payment_method_name,
      coa.name as cash_account_name,
      coa.code as cash_account_code
     FROM vendor_payments vp
     LEFT JOIN business_partners bp ON vp.vendor_id = bp.id
     LEFT JOIN business_partner_addresses addr ON bp.id = addr.partner_id AND addr.is_primary = TRUE
     LEFT JOIN payment_methods pm ON vp.payment_method_id = pm.id
     LEFT JOIN chart_of_accounts coa ON vp.cash_account_id = coa.id
     WHERE ${where.join(" AND ")} 
     ORDER BY vp.payment_date DESC, vp.created_at DESC`,
    params
  );
  return rows;
}

async function getAllocations(vendorPaymentId) {
  const { rows } = await pool.query(
    `SELECT * FROM vendor_payment_allocations WHERE vendor_payment_id=$1 ORDER BY created_at ASC`,
    [vendorPaymentId]
  );
  return rows;
}
async function getVendorPaymentById(orgId, id) {
  const { rows } = await pool.query(
    `SELECT 
      vp.*,
      bp.name as vendor_name,
      bp.email as vendor_email,
      bp.phone as vendor_phone,
      addr.label as vendor_address_label,
      addr.line1 as vendor_address_line1,
      addr.line2 as vendor_address_line2,
      addr.city as vendor_address_city,
      addr.region as vendor_address_region,
      addr.postal_code as vendor_address_postal_code,
      addr.country as vendor_address_country,
      pm.name as payment_method_name,
      coa.name as cash_account_name,
      coa.code as cash_account_code,
      LOWER(d.workflow_state_code) AS workflow_status
     FROM vendor_payments vp
     LEFT JOIN business_partners bp 
       ON vp.vendor_id = bp.id
     LEFT JOIN business_partner_addresses addr 
       ON bp.id = addr.partner_id 
       AND addr.is_primary = TRUE
     LEFT JOIN payment_methods pm 
       ON vp.payment_method_id = pm.id
     LEFT JOIN chart_of_accounts coa 
       ON vp.cash_account_id = coa.id
     LEFT JOIN documents d
       ON d.id = vp.workflow_document_id
       AND d.organization_id = vp.organization_id
     WHERE vp.organization_id = $1 
       AND vp.id = $2`,
    [orgId, id]
  );

  return rows[0] || null;
}
async function listVendorPayments({ orgId, query }) {
  const params = [orgId];
  const where = ["vp.organization_id=$1"];
  let i = 2;

  if (query?.status) { 
    where.push(`vp.status=$${i++}`); 
    params.push(query.status); 
  }
  if (query?.vendor_id) { 
    where.push(`vp.vendor_id=$${i++}`); 
    params.push(query.vendor_id); 
  }

  const { rows } = await pool.query(
    `SELECT 
      vp.*,
      bp.name as vendor_name,
      addr.line1 as vendor_address_line1,
      addr.city as vendor_address_city,
      addr.country as vendor_address_country,
      pm.name as payment_method_name
     FROM vendor_payments vp
     LEFT JOIN business_partners bp ON vp.vendor_id = bp.id
     LEFT JOIN business_partner_addresses addr ON bp.id = addr.partner_id AND addr.is_primary = TRUE
     LEFT JOIN payment_methods pm ON vp.payment_method_id = pm.id
     WHERE ${where.join(" AND ")} 
     ORDER BY vp.payment_date DESC, vp.created_at DESC`,
    params
  );
  return rows;
}

async function deleteAllocations(client, vendorPaymentId) {
  await client.query(
    `DELETE FROM vendor_payment_allocations WHERE vendor_payment_id=$1`,
    [vendorPaymentId]
  );
}

async function recordAllocationEvent(client, { orgId, vendorPaymentId, actorUserId, action, before, after }) {
  await client.query(
    `
    INSERT INTO vendor_payment_allocation_events(
      organization_id, vendor_payment_id, actor_user_id, action, before, after
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [orgId, vendorPaymentId, actorUserId || null, action, before || null, after || null]
  );
}

module.exports = {
  nextPaymentNo,
  insertVendorPayment,
  upsertAllocation,
  deleteAllocations,
  recordAllocationEvent,
  getVendorPaymentById,
  getAllocations,
  listVendorPayments
};
