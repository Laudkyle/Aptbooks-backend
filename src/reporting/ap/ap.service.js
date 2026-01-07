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

async function agedPayables({ orgId, asOfDate }) {
  assertDate(asOfDate, "asOfDate");

  const { rows } = await pool.query(
    `
    WITH alloc AS (
      SELECT
        vpa.bill_id,
        SUM(vpa.amount_applied) AS allocated
      FROM vendor_payment_allocations vpa
      JOIN vendor_payments vp ON vp.id = vpa.vendor_payment_id
      WHERE vp.organization_id=$1
        AND vp.status='posted'
        AND vp.payment_date <= $2::date
      GROUP BY vpa.bill_id
    )
    SELECT
      b.id AS bill_id,
      b.vendor_id,
      bp.name AS vendor_name,
      b.bill_no,
      b.bill_date,
      b.due_date,
      b.currency_code,
      b.total,
      COALESCE(a.allocated,0) AS allocated,
      (b.total - COALESCE(a.allocated,0)) AS outstanding,
      GREATEST(0, ($2::date - b.due_date))::int AS days_past_due
    FROM bills b
    JOIN business_partners bp ON bp.id = b.vendor_id
    LEFT JOIN alloc a ON a.bill_id = b.id
    WHERE b.organization_id=$1
      AND b.status IN ('issued','paid')
      AND b.bill_date <= $2::date
      AND (b.total - COALESCE(a.allocated,0)) > 0
    ORDER BY bp.name, b.due_date, b.bill_no
    `,
    [orgId, asOfDate]
  );

  const byVendor = new Map();
  const totals = { CURRENT: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0, total: 0 };

  for (const r of rows) {
    const bucket = bucketForDaysPastDue(Number(r.days_past_due || 0));
    const outstanding = Number(r.outstanding || 0);
    if (!byVendor.has(r.vendor_id)) {
      byVendor.set(r.vendor_id, {
        vendor_id: r.vendor_id,
        vendor_name: r.vendor_name,
        buckets: { CURRENT: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0, total: 0 },
        bills: []
      });
    }
    const v = byVendor.get(r.vendor_id);
    v.buckets[bucket] += outstanding;
    v.buckets.total += outstanding;
    totals[bucket] += outstanding;
    totals.total += outstanding;
    v.bills.push({
      bill_id: r.bill_id,
      bill_no: r.bill_no,
      bill_date: r.bill_date,
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
    vendors: Array.from(byVendor.values())
  };
}

async function vendorStatement({ orgId, vendorId, fromDate, toDate }) {
  if (!vendorId) throw new AppError(400, "vendorId is required");
  assertDate(fromDate, "from");
  assertDate(toDate, "to");

  const { rows: vendorRows } = await pool.query(
    `SELECT id, name FROM business_partners WHERE id=$1`,
    [vendorId]
  );
  if (!vendorRows.length) throw new AppError(404, "Vendor not found");

  const { rows: openingRows } = await pool.query(
    `
    WITH alloc AS (
      SELECT
        vpa.bill_id,
        SUM(vpa.amount_applied) AS allocated
      FROM vendor_payment_allocations vpa
      JOIN vendor_payments vp ON vp.id = vpa.vendor_payment_id
      WHERE vp.organization_id=$1
        AND vp.status='posted'
        AND vp.payment_date < $3::date
      GROUP BY vpa.bill_id
    )
    SELECT
      COALESCE(SUM(b.total - COALESCE(a.allocated,0)),0) AS opening
    FROM bills b
    LEFT JOIN alloc a ON a.bill_id = b.id
    WHERE b.organization_id=$1
      AND b.vendor_id=$2
      AND b.status IN ('issued','paid')
      AND b.bill_date < $3::date
    `,
    [orgId, vendorId, fromDate]
  );
  const opening = Number(openingRows[0]?.opening || 0);

  const { rows: bills } = await pool.query(
    `
    SELECT id, bill_no, bill_date, due_date, total, memo
    FROM bills
    WHERE organization_id=$1 AND vendor_id=$2
      AND bill_date BETWEEN $3::date AND $4::date
      AND status IN ('issued','paid')
    ORDER BY bill_date, bill_no
    `,
    [orgId, vendorId, fromDate, toDate]
  );

  const { rows: payments } = await pool.query(
    `
    SELECT
      vp.id,
      vp.payment_no,
      vp.payment_date,
      vp.amount_total,
      COALESCE(SUM(vpa.amount_applied),0) AS allocated_total
    FROM vendor_payments vp
    LEFT JOIN vendor_payment_allocations vpa ON vpa.vendor_payment_id = vp.id
    WHERE vp.organization_id=$1 AND vp.vendor_id=$2
      AND vp.status='posted'
      AND vp.payment_date BETWEEN $3::date AND $4::date
    GROUP BY vp.id
    ORDER BY vp.payment_date, vp.payment_no
    `,
    [orgId, vendorId, fromDate, toDate]
  );

  const entries = [];
  for (const b of bills) {
    // Bills increase AP; show as debit to expense, credit AP. Statement perspective: bill increases payable.
    entries.push({
      date: b.bill_date,
      type: "bill",
      reference: b.bill_no,
      description: b.memo || null,
      debit: Number(b.total || 0),
      credit: 0
    });
  }
  for (const p of payments) {
    // Payments reduce AP; show as credit.
    entries.push({
      date: p.payment_date,
      type: "payment",
      reference: p.payment_no,
      description: null,
      debit: 0,
      credit: Number(p.allocated_total || p.amount_total || 0)
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
    vendor: vendorRows[0],
    from: fromDate,
    to: toDate,
    opening_balance: opening,
    closing_balance: running,
    lines
  };
}

module.exports = {
  agedPayables,
  vendorStatement
};
