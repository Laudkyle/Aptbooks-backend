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
async function getVendorPaymentById(orgId, id, currentUserId) {
  const { rows } = await pool.query(
    `SELECT 
      vp.*,
      bp.name AS vendor_name,
      bp.email AS vendor_email,
      bp.phone AS vendor_phone,
      addr.label AS vendor_address_label,
      addr.line1 AS vendor_address_line1,
      addr.line2 AS vendor_address_line2,
      addr.city AS vendor_address_city,
      addr.region AS vendor_address_region,
      addr.postal_code AS vendor_address_postal_code,
      addr.country AS vendor_address_country,
      pm.name AS payment_method_name,
      coa.name AS cash_account_name,
      coa.code AS cash_account_code,
      LOWER(d.workflow_state_code) AS workflow_status,
      CASE
        WHEN d.id IS NOT NULL
         AND LOWER(d.workflow_state_code) = 'submitted'
         AND (
           EXISTS (
             SELECT 1 FROM user_roles ur_admin
             JOIN roles r_admin ON r_admin.id = ur_admin.role_id
             WHERE ur_admin.user_id = $3::uuid
               AND r_admin.organization_id = vp.organization_id
               AND LOWER(r_admin.name) IN ('admin','administrator','super admin','owner')
           )
           OR d.created_by_user_id IS NULL
           OR d.created_by_user_id IS DISTINCT FROM $3::uuid
           OR COALESCE(dws.allow_self_approval, FALSE)
           OR COALESCE(dws.creator_can_approve, FALSE)
         )
         AND EXISTS (
           SELECT 1
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE ur.user_id = $3::uuid
             AND r.organization_id = vp.organization_id
             AND p.code = 'approvals.act'
         )
         AND EXISTS (
           SELECT 1
           FROM document_approvals da
           WHERE da.document_id = d.id
             AND da.status = 'PENDING'
             AND (
               EXISTS (
                 SELECT 1
                 FROM approval_level_users alu_me
                 WHERE alu_me.approval_level_id = da.approval_level_id
                   AND alu_me.user_id = $3::uuid
               )
               OR EXISTS (
                 SELECT 1 FROM user_roles ur_admin2
                 JOIN roles r_admin2 ON r_admin2.id = ur_admin2.role_id
                 WHERE ur_admin2.user_id = $3::uuid
                   AND r_admin2.organization_id = vp.organization_id
                   AND LOWER(r_admin2.name) IN ('admin','administrator','super admin','owner')
               )
             )
         )
        THEN TRUE
        ELSE FALSE
      END AS can_approve,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM user_roles ur_admin_post
          JOIN roles r_admin_post ON r_admin_post.id = ur_admin_post.role_id
          WHERE ur_admin_post.user_id = $3::uuid
            AND r_admin_post.organization_id = vp.organization_id
            AND LOWER(r_admin_post.name) IN ('admin','administrator','super admin','owner')
        ) THEN TRUE
        WHEN d.created_by_user_id = $3
        THEN COALESCE(dws.creator_can_post, FALSE)
        ELSE FALSE
      END AS can_post
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
     LEFT JOIN LATERAL (
       SELECT
         s.creator_can_approve,
         s.creator_can_post,
         s.allow_self_approval
       FROM document_workflow_statics s
       WHERE s.organization_id = vp.organization_id
         AND (
           s.document_type_id = d.document_type_id
           OR s.document_type_id IS NULL
         )
       ORDER BY
         CASE
           WHEN s.document_type_id = d.document_type_id THEN 0
           ELSE 1
         END
       LIMIT 1
     ) dws ON TRUE
     WHERE vp.organization_id = $1 
       AND vp.id = $2`,
    [orgId, id, currentUserId]
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
