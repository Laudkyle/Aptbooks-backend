const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");

function assertIsoDate(d, field) {
  if (!d || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d)) {
    throw new AppError(400, `${field} must be YYYY-MM-DD`);
  }
}

async function vatSummary({ orgId, fromDate, toDate }) {
  assertIsoDate(fromDate, "from");
  assertIsoDate(toDate, "to");
  if (toDate < fromDate) throw new AppError(400, "to must be on or after from");

  // Output VAT: issued/paid invoices
  const { rows: outRows } = await pool.query(
    `
    SELECT
      COALESCE(SUM(COALESCE(il.tax_amount,0)),0) AS output_tax
    FROM invoices i
    JOIN invoice_lines il ON il.invoice_id = i.id
    WHERE i.organization_id=$1
      AND i.status IN ('issued','paid')
      AND i.invoice_date BETWEEN $2 AND $3
    `,
    [orgId, fromDate, toDate]
  );

  // Input VAT: issued/paid bills
  const { rows: inRows } = await pool.query(
    `
    SELECT
      COALESCE(SUM(COALESCE(bl.tax_amount,0)),0) AS input_tax
    FROM bills b
    JOIN bill_lines bl ON bl.bill_id = b.id
    WHERE b.organization_id=$1
      AND b.status IN ('issued','paid')
      AND b.bill_date BETWEEN $2 AND $3
    `,
    [orgId, fromDate, toDate]
  );

  const outputTax = Number(outRows[0]?.output_tax || 0);
  const inputTax = Number(inRows[0]?.input_tax || 0);

  return {
    from: fromDate,
    to: toDate,
    outputTax: Number(outputTax.toFixed(2)),
    inputTax: Number(inputTax.toFixed(2)),
    netTaxPayable: Number((outputTax - inputTax).toFixed(2))
  };
}

module.exports = { vatSummary, vatReturn, listReturns };

// ============================================================
// Stage 6: VAT/GST returns (box-based) + persistence
// ============================================================

async function vatReturn({ orgId, userId, fromDate, toDate, templateCode }) {
  assertIsoDate(fromDate, "from");
  assertIsoDate(toDate, "to");
  if (toDate < fromDate) throw new AppError(400, "to must be on or after from");

  // Choose a template if provided; otherwise use first VAT template.
  let template = null;
  if (templateCode) {
    const { rows } = await pool.query(
      `
      SELECT id, code, name
      FROM tax_return_templates
      WHERE organization_id=$1 AND tax_type='VAT' AND code=$2
      `,
      [orgId, templateCode]
    );
    template = rows[0] || null;
    if (!template) throw new AppError(404, "Tax return template not found");
  } else {
    const { rows } = await pool.query(
      `
      SELECT id, code, name
      FROM tax_return_templates
      WHERE organization_id=$1 AND tax_type='VAT'
      ORDER BY code
      LIMIT 1
      `,
      [orgId]
    );
    template = rows[0] || null;
  }

  // Load template boxes; if no template, fall back to grouping by tax_codes.box_code.
  let templateBoxes = [];
  if (template) {
    const { rows } = await pool.query(
      `
      SELECT box_code, label, sort_order, direction
      FROM tax_return_template_boxes
      WHERE template_id=$1
      ORDER BY sort_order, box_code
      `,
      [template.id]
    );
    templateBoxes = rows;
  }

  // Compute box totals using invoice/bill line tax_amount and tax_codes.box_code.
  const { rows: boxRows } = await pool.query(
    `
    WITH inv AS (
      SELECT
        tc.box_code,
        COALESCE(tc.direction,'output') AS direction,
        SUM(COALESCE(il.tax_amount,0)) AS tax_amount
      FROM invoices i
      JOIN invoice_lines il ON il.invoice_id=i.id
      LEFT JOIN tax_codes tc ON tc.id = il.tax_code_id
      WHERE i.organization_id=$1
        AND i.status IN ('issued','paid')
        AND i.invoice_date BETWEEN $2::date AND $3::date
      GROUP BY tc.box_code, COALESCE(tc.direction,'output')
    ), bil AS (
      SELECT
        tc.box_code,
        COALESCE(tc.direction,'input') AS direction,
        SUM(COALESCE(bl.tax_amount,0)) AS tax_amount
      FROM bills b
      JOIN bill_lines bl ON bl.bill_id=b.id
      LEFT JOIN tax_codes tc ON tc.id = bl.tax_code_id
      WHERE b.organization_id=$1
        AND b.status IN ('issued','paid')
        AND b.bill_date BETWEEN $2::date AND $3::date
      GROUP BY tc.box_code, COALESCE(tc.direction,'input')
    )
    SELECT box_code, direction, SUM(tax_amount) AS tax_amount
    FROM (
      SELECT * FROM inv
      UNION ALL
      SELECT * FROM bil
    ) u
    WHERE box_code IS NOT NULL
    GROUP BY box_code, direction
    ORDER BY box_code, direction
    `,
    [orgId, fromDate, toDate]
  );

  const byBox = new Map();
  for (const r of boxRows) {
    const k = `${r.box_code}::${r.direction}`;
    byBox.set(k, Number(r.tax_amount || 0));
  }

  const boxes = (templateBoxes.length ? templateBoxes : Array.from(new Set(boxRows.map((r) => `${r.box_code}::${r.direction}`))).map((k) => {
    const [box_code, direction] = k.split("::");
    return { box_code, label: box_code, sort_order: 0, direction };
  }))
    .map((b) => ({
      box_code: b.box_code,
      label: b.label,
      direction: b.direction || null,
      amount: Number((byBox.get(`${b.box_code}::${b.direction || 'output'}`) || byBox.get(`${b.box_code}::${b.direction || 'input'}`) || 0).toFixed(2))
    }));

  const outputTotal = boxes
    .filter((b) => (b.direction || "output") === "output")
    .reduce((s, b) => s + Number(b.amount || 0), 0);
  const inputTotal = boxes
    .filter((b) => (b.direction || "input") === "input")
    .reduce((s, b) => s + Number(b.amount || 0), 0);
  const netPayable = outputTotal - inputTotal;

  const payload = {
    tax_type: "VAT",
    from: fromDate,
    to: toDate,
    template: template ? { id: template.id, code: template.code, name: template.name } : null,
    boxes,
    totals: {
      output_tax: Number(outputTotal.toFixed(2)),
      input_tax: Number(inputTotal.toFixed(2)),
      net_tax_payable: Number(netPayable.toFixed(2))
    }
  };

  // Persist a draft snapshot (idempotent for the same period)
  const { rows: saved } = await pool.query(
    `
    INSERT INTO tax_returns (organization_id, tax_type, from_date, to_date, status, template_id, payload_json, created_by)
    VALUES ($1,'VAT',$2::date,$3::date,'draft',$4,$5::jsonb,$6)
    ON CONFLICT (organization_id, tax_type, from_date, to_date, status)
    DO UPDATE SET payload_json=EXCLUDED.payload_json, template_id=EXCLUDED.template_id
    RETURNING id
    `,
    [orgId, fromDate, toDate, template ? template.id : null, JSON.stringify(payload), userId || null]
  );

  return { return_id: saved[0]?.id, ...payload };
}

async function listReturns({ orgId, taxType, fromDate, toDate }) {
  const t = taxType || "VAT";
  if (!['VAT','GST','SALES'].includes(t)) throw new AppError(400, "taxType must be VAT, GST, or SALES");

  const params = [orgId, t];
  let where = "";
  if (fromDate) {
    assertIsoDate(fromDate, "from");
    params.push(fromDate);
    where += ` AND tr.from_date >= $${params.length}::date`;
  }
  if (toDate) {
    assertIsoDate(toDate, "to");
    params.push(toDate);
    where += ` AND tr.to_date <= $${params.length}::date`;
  }

  const { rows } = await pool.query(
    `
    SELECT
      tr.id,
      tr.tax_type,
      tr.from_date,
      tr.to_date,
      tr.status,
      tr.created_at,
      tr.finalized_at,
      tr.template_id
    FROM tax_returns tr
    WHERE tr.organization_id=$1
      AND tr.tax_type=$2
      ${where}
    ORDER BY tr.from_date DESC, tr.created_at DESC
    `,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    tax_type: r.tax_type,
    from: r.from_date,
    to: r.to_date,
    status: r.status,
    created_at: r.created_at,
    finalized_at: r.finalized_at,
    template_id: r.template_id
  }));
}
