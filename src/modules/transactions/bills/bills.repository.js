const { pool } = require("../../../db/pool");

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

async function insertBill(client, { orgId, vendorId, billNo, billDate, dueDate, memo, subtotal, total }) {
  const { rows } = await client.query(
    `
    INSERT INTO bills(
      organization_id, vendor_id, bill_no, bill_date, due_date,
      currency_code, fx_rate, status, memo, subtotal, total
    )
    VALUES ($1,$2,$3,$4,$5,'GHS',1,'draft',$6,$7,$8)
    RETURNING *
    `,
    [orgId, vendorId, billNo, billDate, dueDate, memo || null, subtotal, total]
  );
  return rows[0];
}

async function insertBillLine(client, { billId, lineNo, description, quantity, unitPrice, lineTotal, expenseAccountId }) {
  await client.query(
    `
    INSERT INTO bill_lines(
      bill_id, line_no, description, quantity, unit_price, line_total, expense_account_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [billId, lineNo, description, quantity, unitPrice, lineTotal, expenseAccountId]
  );
}

async function getBillById(orgId, billId) {
  const { rows } = await pool.query(
    `SELECT * FROM bills WHERE organization_id=$1 AND id=$2`,
    [orgId, billId]
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
