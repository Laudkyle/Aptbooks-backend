const { pool } = require("../../../db/pool");
const { insertLineTaxDetails } = require("../../../shared/tax/multiTax");

async function nextBillNo(client, orgId) {
  await client.query(
    `INSERT INTO bill_sequences(organization_id, next_no)
     VALUES ($1, 1) ON CONFLICT (organization_id) DO NOTHING`,
    [orgId]
  );

  const { rows } = await client.query(
    `UPDATE bill_sequences SET next_no = next_no + 1, updated_at=NOW()
     WHERE organization_id=$1 RETURNING next_no`,
    [orgId]
  );

  const no = BigInt(rows[0].next_no) - 1n;
  return `BILL-${String(no).padStart(6, "0")}`;
}

async function insertBill(client, { orgId, vendorId, billNo, billDate, dueDate, memo, subtotal, taxTotal, total, withholdingTotal = 0, netSettlementTotal = null, currencyCode, createdBy }) {
  const { rows } = await client.query(
    `
    INSERT INTO bills(
      organization_id, vendor_id, bill_no, bill_date, due_date,
      currency_code, fx_rate, status, memo, subtotal, tax_total, total, withholding_total, net_settlement_total, created_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,1,'draft',$7,$8,$9,$10,$11,$12,$13)
    RETURNING *
    `,
    [orgId, vendorId, billNo, billDate, dueDate, currencyCode, memo || null, subtotal, taxTotal || 0, total, withholdingTotal || 0, netSettlementTotal ?? total, createdBy || null]
  );
  return rows[0];
}

async function insertBillLine(client, { billId, lineNo, description, quantity, unitPrice, lineTotal, expenseAccountId, taxCodeId, taxAmount, taxableAmount = 0, taxSnapshot = {}, taxDetails = [] }) {
  const { rows } = await client.query(
    `
    INSERT INTO bill_lines(
      bill_id, line_no, description, quantity, unit_price, line_total, expense_account_id, tax_code_id, tax_amount, taxable_amount, tax_snapshot_json
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    RETURNING *
    `,
    [billId, lineNo, description, quantity, unitPrice, lineTotal, expenseAccountId, taxCodeId || null, taxAmount || 0, taxableAmount || 0, JSON.stringify(taxSnapshot || {})]
  );
  await insertLineTaxDetails({ client, tableName: "bill_line_tax_details", lineId: rows[0].id, details: taxDetails });
}

async function getBillById(orgId, billId, currentUserId) {
  const { rows } = await pool.query(
    `SELECT 
      b.*,
      bp.name AS vendor_name,
      bp.code AS vendor_code,
      bp.email AS vendor_email,
      LOWER(d.workflow_state_code) AS workflow_status,
      CASE
        WHEN d.id IS NOT NULL
         AND LOWER(d.workflow_state_code) = 'submitted'
         AND (
           EXISTS (
             SELECT 1 FROM user_roles ur_admin
             JOIN roles r_admin ON r_admin.id = ur_admin.role_id
             WHERE ur_admin.user_id = $3::uuid
               AND r_admin.organization_id = b.organization_id
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
             AND r.organization_id = b.organization_id
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
                   AND r_admin2.organization_id = b.organization_id
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
            AND r_admin_post.organization_id = b.organization_id
            AND LOWER(r_admin_post.name) IN ('admin','administrator','super admin','owner')
        ) THEN TRUE
        WHEN d.created_by_user_id = $3
        THEN COALESCE(dws.creator_can_post, FALSE)
        ELSE FALSE
      END AS can_post
     FROM bills b
     LEFT JOIN business_partners bp
       ON bp.id=b.vendor_id
      AND bp.organization_id=b.organization_id
     LEFT JOIN documents d
       ON d.id = b.workflow_document_id
      AND d.organization_id = b.organization_id
     LEFT JOIN LATERAL (
       SELECT
         s.creator_can_approve,
         s.creator_can_post,
         s.allow_self_approval
       FROM document_workflow_statics s
       WHERE s.organization_id = b.organization_id
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
     WHERE b.organization_id = $1 
       AND b.id = $2`,
    [orgId, billId, currentUserId]
  );

  return rows[0] || null;
}
async function getBillLines(billId) {
  const { rows } = await pool.query(
    `SELECT * FROM bill_lines WHERE bill_id=$1 ORDER BY line_no`,
    [billId]
  );
  return rows;
}

async function listBills({ orgId, query }) {
  const params = [orgId];
  const where = ["b.organization_id=$1"];
  let i = 2;

  if (query?.status) { where.push(`b.status=$${i++}`); params.push(query.status); }
  if (query?.vendorId) { where.push(`b.vendor_id=$${i++}`); params.push(query.vendorId); }

  const { rows } = await pool.query(
    `SELECT b.*, bp.name AS vendor_name, bp.code AS vendor_code
       FROM bills b
       LEFT JOIN business_partners bp ON bp.id=b.vendor_id AND bp.organization_id=b.organization_id
      WHERE ${where.join(" AND ")} ORDER BY b.bill_date DESC, b.created_at DESC`,
    params
  );
  return rows;
}

module.exports = { nextBillNo, insertBill, insertBillLine, getBillById, getBillLines, listBills };
