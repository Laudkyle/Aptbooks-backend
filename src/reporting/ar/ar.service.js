const { AppError } = require("../../shared/errors/AppError");
const { pool } = require("../../db/pool");

function assertDate(value, fieldName) {
  if (!value) throw new AppError(400, `${fieldName} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new AppError(400, `${fieldName} must be YYYY-MM-DD`);
}

function bucketForDaysPastDue(dpd) {
  if (dpd <= 0) return "CURRENT";
  if (dpd <= 30) return "1-30";
  if (dpd <= 60) return "31-60";
  if (dpd <= 90) return "61-90";
  return "90+";
}

async function agedReceivables({ orgId, asOfDate }) {
  assertDate(asOfDate, "asOfDate");

  // Net outstanding = invoice.total - SUM(posted receipt allocations up to asOfDate)
  const { rows } = await pool.query(
    `
    WITH alloc AS (
      SELECT
        cra.invoice_id,
        SUM(cra.amount_applied) AS allocated
      FROM customer_receipt_allocations cra
      JOIN customer_receipts cr ON cr.id = cra.customer_receipt_id
      WHERE cr.organization_id=$1
        AND cr.status='posted'
        AND cr.receipt_date <= $2::date
      GROUP BY cra.invoice_id
    )
    SELECT
      i.id AS invoice_id,
      i.customer_id,
      bp.name AS customer_name,
      i.invoice_no,
      i.invoice_date,
      i.due_date,
      i.currency_code,
      i.total,
      COALESCE(a.allocated,0) AS allocated,
      (i.total - COALESCE(a.allocated,0)) AS outstanding,
      GREATEST(0, ($2::date - i.due_date))::int AS days_past_due
    FROM invoices i
    JOIN business_partners bp ON bp.id = i.customer_id
    LEFT JOIN alloc a ON a.invoice_id = i.id
    WHERE i.organization_id=$1
      AND i.status IN ('issued','paid')
      AND i.invoice_date <= $2::date
      AND (i.total - COALESCE(a.allocated,0)) > 0
    ORDER BY bp.name, i.due_date, i.invoice_no
    `,
    [orgId, asOfDate]
  );

  const byCustomer = new Map();
  const totals = { CURRENT: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0, total: 0 };

  for (const r of rows) {
    const bucket = bucketForDaysPastDue(Number(r.days_past_due || 0));
    const outstanding = Number(r.outstanding || 0);
    if (!byCustomer.has(r.customer_id)) {
      byCustomer.set(r.customer_id, {
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        buckets: { CURRENT: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0, total: 0 },
        invoices: []
      });
    }
    const c = byCustomer.get(r.customer_id);
    c.buckets[bucket] += outstanding;
    c.buckets.total += outstanding;
    totals[bucket] += outstanding;
    totals.total += outstanding;
    c.invoices.push({
      invoice_id: r.invoice_id,
      invoice_no: r.invoice_no,
      invoice_date: r.invoice_date,
      due_date: r.due_date,
      currency_code: r.currency_code,
      total: Number(r.total || 0),
      allocated: Number(r.allocated || 0),
      outstanding,
      days_past_due: Number(r.days_past_due || 0),
      bucket
    });
  }

  return {
    as_of_date: asOfDate,
    totals,
    customers: Array.from(byCustomer.values())
  };
}

async function customerStatement({ orgId, customerId, fromDate, toDate }) {
  if (!customerId) throw new AppError(400, "customerId is required");
  assertDate(fromDate, "from");
  assertDate(toDate, "to");

  const { rows: customerRows } = await pool.query(
    `SELECT id, name FROM business_partners WHERE id=$1`,
    [customerId]
  );
  if (!customerRows.length) throw new AppError(404, "Customer not found");

  // Opening balance: outstanding as of day before fromDate
  const { rows: openingRows } = await pool.query(
    `
    WITH alloc AS (
      SELECT
        cra.invoice_id,
        SUM(cra.amount_applied) AS allocated
      FROM customer_receipt_allocations cra
      JOIN customer_receipts cr ON cr.id = cra.customer_receipt_id
      WHERE cr.organization_id=$1
        AND cr.status='posted'
        AND cr.receipt_date < $3::date
      GROUP BY cra.invoice_id
    )
    SELECT
      COALESCE(SUM(i.total - COALESCE(a.allocated,0)),0) AS opening
    FROM invoices i
    LEFT JOIN alloc a ON a.invoice_id = i.id
    WHERE i.organization_id=$1
      AND i.customer_id=$2
      AND i.status IN ('issued','paid')
      AND i.invoice_date < $3::date
    `,
    [orgId, customerId, fromDate]
  );
  const opening = Number(openingRows[0]?.opening || 0);

  // Activity: invoices and receipts within [fromDate, toDate]
  const { rows: invoices } = await pool.query(
    `
    SELECT id, invoice_no, invoice_date, due_date, total, memo
    FROM invoices
    WHERE organization_id=$1 AND customer_id=$2
      AND invoice_date BETWEEN $3::date AND $4::date
      AND status IN ('issued','paid')
    ORDER BY invoice_date, invoice_no
    `,
    [orgId, customerId, fromDate, toDate]
  );

  const { rows: receipts } = await pool.query(
    `
    SELECT
      cr.id,
      cr.receipt_no,
      cr.receipt_date,
      cr.amount_total,
      cr.memo,
      COALESCE(SUM(cra.amount_applied),0) AS allocated_total
    FROM customer_receipts cr
    LEFT JOIN customer_receipt_allocations cra ON cra.customer_receipt_id = cr.id
    WHERE cr.organization_id=$1 AND cr.customer_id=$2
      AND cr.status='posted'
      AND cr.receipt_date BETWEEN $3::date AND $4::date
    GROUP BY cr.id
    ORDER BY cr.receipt_date, cr.receipt_no
    `,
    [orgId, customerId, fromDate, toDate]
  );

  // Build a combined statement (opening balance then chronological entries)
  const entries = [];
  for (const i of invoices) {
    entries.push({
      date: i.invoice_date,
      type: "invoice",
      reference: i.invoice_no,
      description: i.memo || null,
      debit: Number(i.total || 0),
      credit: 0
    });
  }
  for (const r of receipts) {
    // Receipts reduce AR; show as credit.
    entries.push({
      date: r.receipt_date,
      type: "receipt",
      reference: r.receipt_no,
      description: r.memo || null,
      debit: 0,
      credit: Number(r.allocated_total || r.amount_total || 0)
    });
  }
  entries.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.reference).localeCompare(String(b.reference)));

  let running = opening;
  const lines = [{
    date: fromDate,
    type: "opening_balance",
    reference: null,
    description: "Opening balance",
    debit: 0,
    credit: 0,
    balance: running
  }];
  for (const e of entries) {
    running += Number(e.debit || 0) - Number(e.credit || 0);
    lines.push({ ...e, balance: running });
  }

  return {
    customer: customerRows[0],
    from: fromDate,
    to: toDate,
    opening_balance: opening,
    closing_balance: running,
    lines
  };
}

module.exports = {
  agedReceivables,
  customerStatement
};
