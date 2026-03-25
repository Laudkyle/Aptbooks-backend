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

async function insertBill(client, { orgId, vendorId, billNo, billDate, dueDate, memo, subtotal, taxTotal, total, currencyCode }) {
  const { rows } = await client.query(
    `
    INSERT INTO bills(
      organization_id, vendor_id, bill_no, bill_date, due_date,
      currency_code, fx_rate, status, memo, subtotal, tax_total, total
    )
    VALUES ($1,$2,$3,$4,$5,$6,1,'draft',$7,$8,$9,$10)
    RETURNING *
    `,
    [orgId, vendorId, billNo, billDate, dueDate, currencyCode, memo || null, subtotal, taxTotal || 0, total]
  );
  return rows[0];
}

async function insertBillLine(client, { billId, lineNo, description, quantity, unitPrice, lineTotal, expenseAccountId, taxCodeId, taxAmount, taxDetails = [] }) {
  const { rows } = await client.query(
    `
    INSERT INTO bill_lines(
      bill_id, line_no, description, quantity, unit_price, line_total, expense_account_id, tax_code_id, tax_amount
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
    `,
    [billId, lineNo, description, quantity, unitPrice, lineTotal, expenseAccountId, taxCodeId || null, taxAmount || 0]
  );
  await insertLineTaxDetails({ client, tableName: "bill_line_tax_details", lineId: rows[0].id, details: taxDetails });
}

async function getBillById(orgId, billId, currentUserId) {
  const { rows } = await pool.query(
    `SELECT 
      b.*,
      LOWER(d.workflow_state_code) AS workflow_status,
      CASE
        WHEN d.created_by_user_id = $3
        THEN COALESCE(dws.creator_can_approve, FALSE)
        ELSE FALSE
      END AS can_approve,
      CASE
        WHEN d.created_by_user_id = $3
        THEN COALESCE(dws.creator_can_post, FALSE)
        ELSE FALSE
      END AS can_post
     FROM bills b
     LEFT JOIN documents d
       ON d.id = b.workflow_document_id
      AND d.organization_id = b.organization_id
     LEFT JOIN LATERAL (
       SELECT
         s.creator_can_approve,
         s.creator_can_post
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
  const where = ["organization_id=$1"];
  let i = 2;

  if (query?.status) { where.push(`status=$${i++}`); params.push(query.status); }
  if (query?.vendorId) { where.push(`vendor_id=$${i++}`); params.push(query.vendorId); }

  const { rows } = await pool.query(
    `SELECT * FROM bills WHERE ${where.join(" AND ")} ORDER BY bill_date DESC, created_at DESC`,
    params
  );
  return rows;
}

module.exports = { nextBillNo, insertBill, insertBillLine, getBillById, getBillLines, listBills };
