const { pool } = require("../../db/pool");
const Decimal = require("decimal.js");
const { AppError } = require("../../shared/errors/AppError");
const { withTransaction } = require("../../db/tx");
const documentableSvc = require("../../workflow/documents/documentable.service");

function assertIsoDate(d, field) {
  if (!d || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d)) {
    throw new AppError(400, `${field} must be YYYY-MM-DD`);
  }
}

function d(value) {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return new Decimal(String(value));
}


function normalizeCountryPackReportRow(row) {
  if (!row) return row;
  const installed = Boolean(row.is_installed || row.isInstalled);
  const active = row.is_active !== false;
  return {
    id: row.id,
    countryCode: row.country_code || row.countryCode || null,
    packCode: row.pack_code || row.packCode || row.code || null,
    name: row.name || null,
    version: row.version_no || row.version || null,
    scope: row.organization_id ? 'Organization' : 'Default',
    status: installed ? 'installed' : (active ? 'available' : 'inactive'),
    readiness: active ? 'ready' : 'not_ready',
    isInstalled: installed,
    installedAt: row.installed_at || row.installedAt || null
  };
}

function money(value) {
  return d(value).toDecimalPlaces(2).toFixed(2);
}

function addMoney(values) {
  return money(values.reduce((acc, value) => acc.plus(d(value)), new Decimal(0)));
}

function isGhanaVatRow(row) {
  const code = String(row.tax_code || '').toUpperCase();
  const type = String(row.tax_type || '').toUpperCase();
  return type === 'VAT' || code.startsWith('GH_VAT') || code.includes('NHIL') || code.includes('GETFUND');
}

function normalizedPercent(value) {
  const pct = d(value === null || value === undefined ? 1 : value);
  return pct.greaterThan(1) ? pct.div(100) : pct;
}

function mustBeRange(fromDate, toDate) {
  assertIsoDate(fromDate, 'from');
  assertIsoDate(toDate, 'to');
  if (toDate < fromDate) throw new AppError(400, 'to must be on or after from');
}

async function getTaxTransactionRows({ orgId, fromDate, toDate, taxType = null }) {
  assertIsoDate(fromDate, "from");
  assertIsoDate(toDate, "to");
  if (toDate < fromDate) throw new AppError(400, "to must be on or after from");

  const params = [orgId, fromDate, toDate];
  let taxTypeFilter = "";
  if (taxType) {
    params.push(taxType);
    taxTypeFilter = ` AND src.tax_type = $4 `;
  }

  const { rows } = await pool.query(
    `
    WITH src AS (
      SELECT 'invoice'::text AS entity_type, i.id AS entity_id, i.invoice_no AS document_no,
             i.invoice_date AS document_date, i.status,
             i.customer_id AS partner_id, bp.name AS partner_name,
             il.id AS line_id, il.line_no, il.description,
             d.taxable_amount,
             d.tax_amount,
             d.tax_code_id, tc.code AS tax_code, tc.name AS tax_code_name,
             COALESCE(d.tax_type, tc.tax_type) AS tax_type,
             COALESCE(d.tax_scope, tc.tax_scope) AS tax_scope,
             COALESCE(d.direction, tc.direction, 'output') AS direction,
             COALESCE(d.box_code, tc.box_code) AS box_code,
             1::numeric AS sign_factor
      FROM invoices i
      JOIN invoice_lines il ON il.invoice_id = i.id
      JOIN invoice_line_tax_details d ON d.line_id = il.id
      LEFT JOIN tax_codes tc ON tc.id = d.tax_code_id
      LEFT JOIN business_partners bp ON bp.id = i.customer_id
      WHERE i.organization_id=$1 AND i.status IN ('issued','paid') AND i.invoice_date BETWEEN $2::date AND $3::date

      UNION ALL
      SELECT 'bill', b.id, b.bill_no, b.bill_date, b.status,
             b.vendor_id, bp.name,
             bl.id, bl.line_no, bl.description,
             d.taxable_amount,
             d.tax_amount,
             d.tax_code_id, tc.code, tc.name,
             COALESCE(d.tax_type, tc.tax_type),
             COALESCE(d.tax_scope, tc.tax_scope),
             COALESCE(d.direction, tc.direction, 'input'),
             COALESCE(d.box_code, tc.box_code),
             1::numeric
      FROM bills b
      JOIN bill_lines bl ON bl.bill_id = b.id
      JOIN bill_line_tax_details d ON d.line_id = bl.id
      LEFT JOIN tax_codes tc ON tc.id = d.tax_code_id
      LEFT JOIN business_partners bp ON bp.id = b.vendor_id
      WHERE b.organization_id=$1 AND b.status IN ('issued','paid') AND b.bill_date BETWEEN $2::date AND $3::date

      UNION ALL
      SELECT 'credit_note', cn.id, cn.credit_note_no, cn.credit_note_date, cn.status,
             cn.customer_id, bp.name,
             cnl.id, cnl.line_no, cnl.description,
             d.taxable_amount,
             d.tax_amount,
             d.tax_code_id, tc.code, tc.name,
             COALESCE(d.tax_type, tc.tax_type),
             COALESCE(d.tax_scope, tc.tax_scope),
             COALESCE(d.direction, tc.direction, 'output'),
             COALESCE(d.box_code, tc.box_code),
             -1::numeric
      FROM credit_notes cn
      JOIN credit_note_lines cnl ON cnl.credit_note_id = cn.id
      JOIN credit_note_line_tax_details d ON d.line_id = cnl.id
      LEFT JOIN tax_codes tc ON tc.id = d.tax_code_id
      LEFT JOIN business_partners bp ON bp.id = cn.customer_id
      WHERE cn.organization_id=$1 AND cn.status='issued' AND cn.credit_note_date BETWEEN $2::date AND $3::date

      UNION ALL
      SELECT 'debit_note', dn.id, dn.debit_note_no, dn.debit_note_date, dn.status,
             dn.vendor_id, bp.name,
             dnl.id, dnl.line_no, dnl.description,
             d.taxable_amount,
             d.tax_amount,
             d.tax_code_id, tc.code, tc.name,
             COALESCE(d.tax_type, tc.tax_type),
             COALESCE(d.tax_scope, tc.tax_scope),
             COALESCE(d.direction, tc.direction, 'input'),
             COALESCE(d.box_code, tc.box_code),
             -1::numeric
      FROM debit_notes dn
      JOIN debit_note_lines dnl ON dnl.debit_note_id = dn.id
      JOIN debit_note_line_tax_details d ON d.line_id = dnl.id
      LEFT JOIN tax_codes tc ON tc.id = d.tax_code_id
      LEFT JOIN business_partners bp ON bp.id = dn.vendor_id
      WHERE dn.organization_id=$1 AND dn.status='issued' AND dn.debit_note_date BETWEEN $2::date AND $3::date

      UNION ALL
      SELECT od.module_code AS entity_type, od.id AS entity_id, od.document_no,
             od.document_date, od.status,
             od.counterparty_partner_id, bp.name,
             odl.id, odl.line_no, odl.description,
             d.taxable_amount,
             d.tax_amount,
             d.tax_code_id, tc.code, tc.name,
             COALESCE(d.tax_type, tc.tax_type),
             COALESCE(d.tax_scope, tc.tax_scope),
             CASE
               WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','')='sales_return' THEN 'output'
               WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','')='purchase_return' THEN 'input'
               ELSE COALESCE(d.direction, tc.direction, 'input')
             END,
             COALESCE(d.box_code, tc.box_code),
             CASE
               WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','') IN ('sales_return','purchase_return') THEN -1::numeric
               ELSE 1::numeric
             END AS sign_factor
      FROM operational_documents od
      JOIN operational_document_lines odl ON odl.document_id = od.id
      JOIN operational_doc_line_tax_details d ON d.line_id = odl.id
      LEFT JOIN tax_codes tc ON tc.id = d.tax_code_id
      LEFT JOIN business_partners bp ON bp.id = od.counterparty_partner_id
      WHERE od.organization_id=$1
        AND od.status='posted'
        AND od.module_code IN ('expense','petty_cash','return')
        AND od.document_date BETWEEN $2::date AND $3::date

      UNION ALL
      SELECT 'tax_adjustment', ta.id, CONCAT('TAX-ADJ-', LEFT(ta.id::text,8)), ta.adjustment_date, ta.status,
             NULL::uuid, NULL::text,
             ta.id, 1, ta.description,
             0::numeric, ABS(ta.amount),
             NULL::uuid, NULL::text, NULL::text, ta.tax_type,
             NULL::text AS tax_scope, ta.direction, ta.box_code,
             CASE WHEN ta.amount < 0 THEN -1::numeric ELSE 1::numeric END
      FROM tax_adjustments ta
      WHERE ta.organization_id=$1 AND ta.status='posted' AND ta.adjustment_date BETWEEN $2::date AND $3::date
    )
    SELECT entity_type, entity_id, document_no, document_date, status, partner_id, partner_name,
           line_id, line_no, description, taxable_amount, tax_amount, tax_code_id, tax_code, tax_code_name,
           tax_type, tax_scope, direction, box_code, sign_factor,
           ROUND((taxable_amount * sign_factor)::numeric, 2) AS signed_taxable_amount,
           ROUND((tax_amount * sign_factor)::numeric, 2) AS signed_tax_amount
    FROM src
    WHERE COALESCE(tax_amount,0) <> 0
      ${taxTypeFilter}
    ORDER BY document_date DESC, document_no, line_no
    `,
    params
  );

  return rows.map((r) => ({
    ...r,
    taxable_amount: money(r.taxable_amount),
    tax_amount: money(r.tax_amount),
    signed_taxable_amount: money(r.signed_taxable_amount),
    signed_tax_amount: money(r.signed_tax_amount)
  }));
}

async function vatSummary({ orgId, fromDate, toDate, includeGhanaComponents = false }) {
  const rows0 = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: includeGhanaComponents ? null : 'VAT' });
  const rows = includeGhanaComponents ? rows0.filter(isGhanaVatRow) : rows0;
  const outputTax = rows.filter((r) => r.direction === 'output').reduce((sum, r) => sum.plus(d(r.signed_tax_amount)), new Decimal(0));
  const inputTax = rows.filter((r) => r.direction === 'input').reduce((sum, r) => sum.plus(d(r.signed_tax_amount)), new Decimal(0));
  const byComponent = rows.reduce((acc, row) => {
    const key = row.tax_code || row.tax_type || 'UNMAPPED';
    const prev = d(acc[key] || 0);
    acc[key] = money(prev.plus(d(row.signed_tax_amount)));
    return acc;
  }, {});
  return {
    from: fromDate,
    to: toDate,
    outputTax: money(outputTax),
    inputTax: money(inputTax),
    netTaxPayable: money(outputTax.minus(inputTax)),
    componentBreakdown: byComponent,
    sourceBreakdown: rows.reduce((acc, row) => {
      acc[row.entity_type] = money(d(acc[row.entity_type] || 0).plus(d(row.signed_tax_amount)));
      return acc;
    }, {})
  };
}

async function resolveVatTemplate({ orgId, templateCode = null, taxType = 'VAT' }) {
  if (templateCode) {
    const { rows } = await pool.query(`SELECT id, code, name FROM tax_return_templates WHERE organization_id=$1 AND tax_type=$2 AND code=$3`, [orgId, taxType, templateCode]);
    if (!rows[0]) throw new AppError(404, 'Tax return template not found');
    return rows[0];
  }
  const { rows } = await pool.query(`SELECT id, code, name FROM tax_return_templates WHERE organization_id=$1 AND tax_type=$2 ORDER BY code LIMIT 1`, [orgId, taxType]);
  return rows[0] || null;
}

async function buildVatReturnPayload({ orgId, fromDate, toDate, templateCode = null, includeGhanaComponents = false }) {
  mustBeRange(fromDate, toDate);
  const template = await resolveVatTemplate({ orgId, templateCode, taxType: 'VAT' });

  let templateBoxes = [];
  if (template) {
    const { rows } = await pool.query(`SELECT box_code, label, sort_order, direction FROM tax_return_template_boxes WHERE template_id=$1 ORDER BY sort_order, box_code`, [template.id]);
    templateBoxes = rows;
  }

  const sourceRows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: includeGhanaComponents ? null : 'VAT' });
  const rows = includeGhanaComponents ? sourceRows.filter(isGhanaVatRow) : sourceRows;
  const byBox = new Map();
  for (const row of rows) {
    const box = row.box_code || 'UNMAPPED';
    const key = `${box}::${row.direction || ''}`;
    const current = byBox.get(key) || { taxable: new Decimal(0), tax: new Decimal(0), count: 0, transactions: [] };
    current.taxable = current.taxable.plus(d(row.signed_taxable_amount));
    current.tax = current.tax.plus(d(row.signed_tax_amount));
    current.count += 1;
    current.transactions.push(row);
    byBox.set(key, current);
  }

  const fallbackBoxes = Array.from(byBox.keys()).map((k) => {
    const [box_code, direction] = k.split('::');
    return { box_code, label: box_code, sort_order: 0, direction: direction || null };
  });

  const boxes = (templateBoxes.length ? templateBoxes : fallbackBoxes).map((b) => {
    const keys = b.direction ? [`${b.box_code}::${b.direction}`] : [`${b.box_code}::output`, `${b.box_code}::input`, `${b.box_code}::`];
    const selected = keys.map((key) => byBox.get(key)).filter(Boolean);
    const taxable = selected.reduce((sum, item) => sum.plus(item.taxable), new Decimal(0));
    const tax = selected.reduce((sum, item) => sum.plus(item.tax), new Decimal(0));
    const tx = selected.flatMap((item) => item.transactions || []);
    return {
      box_code: b.box_code,
      label: b.label,
      direction: b.direction || null,
      taxable_amount: money(taxable),
      tax_amount: money(tax),
      amount: money(tax),
      transaction_count: tx.length
    };
  });

  const outputTax = rows.filter((r) => r.direction === 'output').reduce((sum, r) => sum.plus(d(r.signed_tax_amount)), new Decimal(0));
  const inputTax = rows.filter((r) => r.direction === 'input').reduce((sum, r) => sum.plus(d(r.signed_tax_amount)), new Decimal(0));
  const taxableTotal = rows.reduce((sum, r) => sum.plus(d(r.signed_taxable_amount)), new Decimal(0));

  return {
    tax_type: 'VAT',
    from: fromDate,
    to: toDate,
    template: template ? { id: template.id, code: template.code, name: template.name } : null,
    boxes,
    totals: {
      taxable_amount: money(taxableTotal),
      output_tax: money(outputTax),
      input_tax: money(inputTax),
      net_tax_payable: money(outputTax.minus(inputTax))
    },
    coverage: {
      transaction_count: rows.length,
      source_types: Array.from(new Set(rows.map((r) => r.entity_type))).sort(),
      includes_ghana_components: Boolean(includeGhanaComponents)
    },
    transactions: rows
  };
}

async function vatReturn({ orgId, fromDate, toDate, templateCode }) {
  return buildVatReturnPayload({ orgId, fromDate, toDate, templateCode, includeGhanaComponents: false });
}

async function createVatReturn({ orgId, userId, fromDate, toDate, templateCode, jurisdictionId = null, includeGhanaComponents = false }) {
  return withTransaction(async (client) => {
    const payload = await buildVatReturnPayload({ orgId, fromDate, toDate, templateCode, includeGhanaComponents });
    const existing = await client.query(
      `SELECT id FROM tax_returns
        WHERE organization_id=$1 AND tax_type='VAT' AND from_date=$2::date AND to_date=$3::date
          AND COALESCE(jurisdiction_id::text,'') = COALESCE($4::uuid::text,'')
          AND COALESCE(is_current, TRUE) = TRUE
        ORDER BY created_at DESC LIMIT 1`,
      [orgId, fromDate, toDate, jurisdictionId || null]
    );
    if (existing.rows[0]) {
      const updated = await client.query(
        `UPDATE tax_returns SET status='draft', template_id=$3, jurisdiction_id=$4, payload_json=$5::jsonb, updated_at=NOW()
          WHERE organization_id=$1 AND id=$2 RETURNING id`,
        [orgId, existing.rows[0].id, payload.template?.id || null, jurisdictionId || null, JSON.stringify(payload)]
      );
      return { return_id: updated.rows[0].id, ...payload };
    }
    const inserted = await client.query(
      `INSERT INTO tax_returns (organization_id, tax_type, from_date, to_date, status, template_id, jurisdiction_id, payload_json, created_by)
       VALUES ($1,'VAT',$2::date,$3::date,'draft',$4,$5,$6::jsonb,$7) RETURNING id`,
      [orgId, fromDate, toDate, payload.template?.id || null, jurisdictionId || null, JSON.stringify(payload), userId || null]
    );
    return { return_id: inserted.rows[0].id, ...payload };
  });
}

async function taxTransactions({ orgId, fromDate, toDate, taxType, direction, entityType }) {
  let rows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: taxType || null });
  if (direction) rows = rows.filter((r) => r.direction === direction);
  if (entityType) rows = rows.filter((r) => r.entity_type === entityType);
  return rows;
}

async function taxReconciliation({ orgId, fromDate, toDate, taxType }) {
  mustBeRange(fromDate, toDate);
  const effectiveTaxType = taxType || 'VAT';
  const rows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: effectiveTaxType || null });
  const bySource = {};
  const byBox = {};
  const issueItems = [];
  for (const row of rows) {
    const sourceKey = `${row.entity_type}::${row.direction}`;
    bySource[sourceKey] = money(d(bySource[sourceKey] || 0).plus(d(row.signed_tax_amount)));
    if (row.box_code) {
      const boxKey = `${row.box_code}::${row.direction}`;
      byBox[boxKey] = money(d(byBox[boxKey] || 0).plus(d(row.signed_tax_amount)));
    }
    if (!row.box_code) issueItems.push({ entity_type: row.entity_type, entity_id: row.entity_id, issue_code: 'missing_box_code', details: row });
    if (!row.direction) issueItems.push({ entity_type: row.entity_type, entity_id: row.entity_id, issue_code: 'missing_direction', details: row });
  }

  const { rows: settingsRows } = await pool.query(`SELECT * FROM tax_settings WHERE organization_id=$1`, [orgId]);
  const settings = settingsRows[0] || {};
  const taxAccountIds = [
    settings.output_tax_account_id,
    settings.input_tax_account_id,
    settings.non_recoverable_input_tax_account_id,
    settings.withholding_tax_payable_account_id,
    settings.withholding_tax_receivable_account_id,
    settings.reverse_charge_tax_account_id
  ].filter(Boolean);

  let glRows = [];
  if (taxAccountIds.length) {
    const gl = await pool.query(
      `SELECT jel.account_id, coa.code AS account_code, coa.name AS account_name,
              SUM(jel.debit)::numeric AS debit_total, SUM(jel.credit)::numeric AS credit_total,
              SUM(jel.debit - jel.credit)::numeric AS net_amount
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
         JOIN chart_of_accounts coa ON coa.id = jel.account_id
        WHERE je.organization_id=$1
          AND je.status='posted'
          AND je.entry_date BETWEEN $2::date AND $3::date
          AND jel.account_id = ANY($4::uuid[])
        GROUP BY jel.account_id, coa.code, coa.name
        ORDER BY coa.code`,
      [orgId, fromDate, toDate, taxAccountIds]
    );
    glRows = gl.rows.map((r) => ({ ...r, debit_total: money(r.debit_total), credit_total: money(r.credit_total), net_amount: money(r.net_amount) }));
  }

  const output = rows.filter((r) => r.direction === 'output').reduce((sum, r) => sum.plus(d(r.signed_tax_amount)), new Decimal(0));
  const input = rows.filter((r) => r.direction === 'input').reduce((sum, r) => sum.plus(d(r.signed_tax_amount)), new Decimal(0));
  const vatPayableBasis = output.minus(input);
  const expectedGlBalance = input.minus(output);
  const glNet = glRows.reduce((sum, r) => sum.plus(d(r.net_amount)), new Decimal(0));
  const difference = glNet.minus(expectedGlBalance);

  const summary = {
    from: fromDate,
    to: toDate,
    taxType: effectiveTaxType,
    transactionCount: rows.length,
    bySource,
    byBox,
    sourceTotals: {
      outputTax: money(output),
      inputTax: money(input),
      vatPayableBasis: money(vatPayableBasis),
      expectedGlBalanceDebitMinusCredit: money(expectedGlBalance),
      signConvention: 'VAT payable is output minus input; GL tax balance is debit minus credit, so payable normally appears negative.'
    },
    glTotals: { taxAccountCount: glRows.length, netAmount: money(glNet), accounts: glRows },
    difference: money(difference),
    status: difference.abs().lessThan(new Decimal('0.01')) && issueItems.length === 0 ? 'balanced' : 'attention_required',
    issues: issueItems
  };

  const { rows: runRows } = await pool.query(
    `INSERT INTO tax_reconciliation_runs (organization_id, tax_type, from_date, to_date, status, summary_json)
     VALUES ($1,$2,$3::date,$4::date,$5,$6::jsonb)
     ON CONFLICT (organization_id, tax_type, from_date, to_date)
     DO UPDATE SET status=EXCLUDED.status, summary_json=EXCLUDED.summary_json
     RETURNING id`,
    [orgId, effectiveTaxType, fromDate, toDate, summary.status, JSON.stringify(summary)]
  );
  const runId = runRows[0]?.id;
  if (runId) {
    await pool.query(`DELETE FROM tax_reconciliation_items WHERE run_id=$1`, [runId]);
    for (const item of issueItems) {
      await pool.query(
        `INSERT INTO tax_reconciliation_items (run_id, entity_type, entity_id, issue_code, details_json) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [runId, item.entity_type, item.entity_id || null, item.issue_code, JSON.stringify(item.details || {})]
      );
    }
  }

  return { runId, ...summary };
}

async function taxDiagnostics({ orgId, fromDate, toDate }) {
  assertIsoDate(fromDate, "from");
  assertIsoDate(toDate, "to");
  const { rows } = await pool.query(
    `
    WITH src AS (
      SELECT 'invoice'::text AS entity_type, i.id AS entity_id, i.invoice_no AS document_no, i.invoice_date AS document_date,
             il.line_no, il.description, d.tax_code_id, d.tax_amount, d.box_code, d.direction, d.tax_type
      FROM invoices i
      JOIN invoice_lines il ON il.invoice_id=i.id
      LEFT JOIN invoice_line_tax_details d ON d.line_id = il.id
      WHERE i.organization_id=$1 AND i.status IN ('issued','paid') AND i.invoice_date BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT 'bill', b.id, b.bill_no, b.bill_date,
             bl.line_no, bl.description, d.tax_code_id, d.tax_amount, d.box_code, d.direction, d.tax_type
      FROM bills b
      JOIN bill_lines bl ON bl.bill_id=b.id
      LEFT JOIN bill_line_tax_details d ON d.line_id = bl.id
      WHERE b.organization_id=$1 AND b.status IN ('issued','paid') AND b.bill_date BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT od.module_code, od.id, od.document_no, od.document_date,
             odl.line_no, odl.description, d.tax_code_id, d.tax_amount, d.box_code, d.direction, d.tax_type
      FROM operational_documents od
      JOIN operational_document_lines odl ON odl.document_id = od.id
      LEFT JOIN operational_doc_line_tax_details d ON d.line_id = odl.id
      WHERE od.organization_id=$1 AND od.status='posted' AND od.module_code IN ('expense','petty_cash','return') AND od.document_date BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT 'credit_note', cn.id, cn.credit_note_no, cn.credit_note_date,
             cnl.line_no, cnl.description, d.tax_code_id, d.tax_amount, d.box_code, d.direction, d.tax_type
      FROM credit_notes cn
      JOIN credit_note_lines cnl ON cnl.credit_note_id = cn.id
      LEFT JOIN credit_note_line_tax_details d ON d.line_id = cnl.id
      WHERE cn.organization_id=$1 AND cn.status='issued' AND cn.credit_note_date BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT 'debit_note', dn.id, dn.debit_note_no, dn.debit_note_date,
             dnl.line_no, dnl.description, d.tax_code_id, d.tax_amount, d.box_code, d.direction, d.tax_type
      FROM debit_notes dn
      JOIN debit_note_lines dnl ON dnl.debit_note_id = dn.id
      LEFT JOIN debit_note_line_tax_details d ON d.line_id = dnl.id
      WHERE dn.organization_id=$1 AND dn.status='issued' AND dn.debit_note_date BETWEEN $2::date AND $3::date
    )
    SELECT *,
      CASE
        WHEN tax_code_id IS NOT NULL AND COALESCE(tax_amount,0)=0 THEN 'tax_code_with_zero_tax'
        WHEN tax_code_id IS NOT NULL AND box_code IS NULL THEN 'missing_box_mapping'
        WHEN tax_code_id IS NOT NULL AND direction IS NULL THEN 'missing_direction'
        WHEN tax_code_id IS NULL AND COALESCE(tax_amount,0)<>0 THEN 'tax_amount_without_tax_code'
        ELSE NULL
      END AS issue_code
    FROM src
    WHERE (
      (tax_code_id IS NOT NULL AND COALESCE(tax_amount,0)=0)
      OR (tax_code_id IS NOT NULL AND box_code IS NULL)
      OR (tax_code_id IS NOT NULL AND direction IS NULL)
      OR (tax_code_id IS NULL AND COALESCE(tax_amount,0)<>0)
    )
    ORDER BY document_date DESC, document_no, line_no
    `,
    [orgId, fromDate, toDate]
  );
  return rows;
}

async function getReturnById({ orgId, returnId, client = pool }) {
  const { rows } = await client.query(
    `
    SELECT tr.*, tt.code AS template_code, tt.name AS template_name
    FROM tax_returns tr
    LEFT JOIN tax_return_templates tt ON tt.id = tr.template_id
    WHERE tr.organization_id=$1 AND tr.id=$2
    LIMIT 1
    `,
    [orgId, returnId]
  );
  return rows[0] || null;
}

function buildTaxReturnSnapshot(tr) {
  const payload = tr.payload_json || {};
  return {
    header: {
      id: tr.id,
      tax_type: tr.tax_type,
      from_date: tr.from_date,
      to_date: tr.to_date,
      status: tr.status,
      workflow_status: tr.workflow_status,
      template_id: tr.template_id,
      template_code: tr.template_code || null,
      template_name: tr.template_name || null,
      created_at: tr.created_at,
      finalized_at: tr.finalized_at
    },
    lines: Array.isArray(payload.boxes) ? payload.boxes : [],
    totals: payload.totals || {},
    related: { template: tr.template_id ? { id: tr.template_id, code: tr.template_code || null, name: tr.template_name || null } : null },
    meta: { payload_json: payload }
  };
}

async function submitReturnForApproval({ orgId, actorUserId, returnId }) {
  return withTransaction(async (client) => {
    const tr = await getReturnById({ orgId, returnId, client });
    if (!tr) throw new AppError(404, "Tax return not found");
    if (tr.status === "finalized") throw new AppError(409, "Finalized tax returns cannot be submitted");
    if (!["draft", "voided"].includes(tr.status)) throw new AppError(409, "Only draft/voided tax returns can be submitted");
    if (!["draft", "rejected"].includes(tr.workflow_status || "draft")) throw new AppError(409, "Only draft/rejected tax returns can be submitted for approval");

    await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "tax_return",
      entity: tr,
      workflowDocumentId: tr.workflow_document_id,
      snapshot: buildTaxReturnSnapshot(tr),
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await client.query(
          `UPDATE tax_returns SET workflow_document_id=$3, workflow_status='submitted', submitted_at=NOW(), submitted_by_user_id=$4, approved_at=NULL, approved_by_user_id=NULL, rejected_at=NULL, rejected_by_user_id=NULL, rejection_reason=NULL WHERE organization_id=$1 AND id=$2`,
          [orgId, returnId, workflowDocumentId, actorUserId]
        );
      }
    });

    const { rows } = await client.query(
      `UPDATE tax_returns SET workflow_status='submitted', submitted_at=NOW(), submitted_by_user_id=$3, approved_at=NULL, approved_by_user_id=NULL, rejected_at=NULL, rejected_by_user_id=NULL, rejection_reason=NULL WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, returnId, actorUserId]
    );
    return rows[0];
  });
}

async function approveReturnWorkflow({ orgId, actorUserId, returnId, comment }) {
  return withTransaction(async (client) => {
    const tr = await getReturnById({ orgId, returnId, client });
    if (!tr) throw new AppError(404, "Tax return not found");
    if (!tr.workflow_document_id) throw new AppError(409, "Tax return has no workflow document");

    await documentableSvc.approveEntityDocument({ orgId, actorUserId, entityType: "tax_return", workflowDocumentId: tr.workflow_document_id, creatorUserId: tr.created_by || null, comment: comment || null, client });

    const { rows } = await client.query(
      `UPDATE tax_returns SET workflow_status='approved', approved_at=NOW(), approved_by_user_id=$3, rejected_at=NULL, rejected_by_user_id=NULL, rejection_reason=NULL WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, returnId, actorUserId]
    );
    return rows[0];
  });
}

async function rejectReturnWorkflow({ orgId, actorUserId, returnId, comment }) {
  return withTransaction(async (client) => {
    const tr = await getReturnById({ orgId, returnId, client });
    if (!tr) throw new AppError(404, "Tax return not found");
    if (!tr.workflow_document_id) throw new AppError(409, "Tax return has no workflow document");

    await documentableSvc.rejectEntityDocument({ orgId, actorUserId, entityType: "tax_return", workflowDocumentId: tr.workflow_document_id, creatorUserId: tr.created_by || null, comment: comment || null, client });

    const { rows } = await client.query(
      `UPDATE tax_returns SET workflow_status='rejected', rejected_at=NOW(), rejected_by_user_id=$3, rejection_reason=$4 WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, returnId, actorUserId, comment || null]
    );
    return rows[0];
  });
}

async function finalizeReturn({ orgId, actorUserId, returnId }) {
  return withTransaction(async (client) => {
    const tr = await getReturnById({ orgId, returnId, client });
    if (!tr) throw new AppError(404, "Tax return not found");
    if (tr.status === "finalized") throw new AppError(409, "Tax return is already finalized");
    if (tr.status === "voided") throw new AppError(409, "Voided tax returns cannot be finalized");

    await documentableSvc.assertEntityApprovedForAction({ orgId, entityType: "tax_return", workflowDocumentId: tr.workflow_document_id, client, actionLabel: "finalize" });

    const { rows } = await client.query(
      `UPDATE tax_returns SET status='finalized', finalized_at=NOW(), finalized_by=$3 WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, returnId, actorUserId]
    );
    return rows[0];
  });
}

async function listReturns({ orgId, taxType, fromDate, toDate }) {
  const t = taxType || "VAT";
  const allowedTaxTypes = ['VAT','GST','SALES','WITHHOLDING','IMPORT','OTHER'];
  if (!allowedTaxTypes.includes(t)) throw new AppError(400, `taxType must be one of ${allowedTaxTypes.join(', ')}`);

  const params = [orgId, t];
  let where = "";
  if (fromDate) { assertIsoDate(fromDate, "from"); params.push(fromDate); where += ` AND tr.from_date >= $${params.length}::date`; }
  if (toDate) { assertIsoDate(toDate, "to"); params.push(toDate); where += ` AND tr.to_date <= $${params.length}::date`; }

  const { rows } = await pool.query(
    `SELECT tr.id, tr.tax_type, tr.from_date, tr.to_date, tr.status, tr.workflow_status, tr.workflow_document_id, tr.created_at, tr.finalized_at, tr.template_id, tr.jurisdiction_id, COALESCE(tr.return_version,1) AS return_version, COALESCE(tr.amendment_no,0) AS amendment_no, COALESCE(tr.is_current, TRUE) AS is_current FROM tax_returns tr WHERE tr.organization_id=$1 AND tr.tax_type=$2 ${where} ORDER BY tr.from_date DESC, tr.created_at DESC`,
    params
  );

  return rows.map((r) => ({ id: r.id, tax_type: r.tax_type, from: r.from_date, to: r.to_date, status: r.status, workflow_status: r.workflow_status, workflow_document_id: r.workflow_document_id, created_at: r.created_at, finalized_at: r.finalized_at, template_id: r.template_id, jurisdiction_id: r.jurisdiction_id, return_version: r.return_version, amendment_no: r.amendment_no, is_current: r.is_current }));
}


async function buildJurisdictionReturnPayload({ orgId, fromDate, toDate, templateCode, jurisdictionId = null }) {
  mustBeRange(fromDate, toDate);
  const params = [orgId];
  let sql = `SELECT * FROM tax_return_jurisdiction_templates WHERE organization_id=$1`;
  if (templateCode) { params.push(templateCode); sql += ` AND code=$${params.length}`; }
  if (jurisdictionId) { params.push(jurisdictionId); sql += ` AND jurisdiction_id=$${params.length}`; }
  sql += ' ORDER BY updated_at DESC LIMIT 1';
  const tplRows = await pool.query(sql, params);
  const template = tplRows.rows[0];
  if (!template) throw new AppError(404, 'Jurisdiction return template not found');

  const boxRows = await pool.query(`SELECT * FROM tax_return_jurisdiction_boxes WHERE template_id=$1 ORDER BY sort_order, box_code`, [template.id]);
  const txRows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: template.tax_type || 'VAT' });
  const lines = boxRows.rows.map((box) => {
    const filtered = txRows.filter((r) => (!box.direction || r.direction === box.direction) && (!box.tax_scope || (r.tax_scope || '') === box.tax_scope) && (!box.box_code || r.box_code === box.box_code));
    const taxAmount = filtered.reduce((sum, r) => sum.plus(d(r.signed_tax_amount)), new Decimal(0));
    const taxableAmount = filtered.reduce((sum, r) => sum.plus(d(r.signed_taxable_amount)), new Decimal(0));
    return { box_code: box.box_code, label: box.label, direction: box.direction || null, taxable_amount: money(taxableAmount), tax_amount: money(taxAmount), transaction_count: filtered.length };
  });
  const totals = { taxable_amount: addMoney(lines.map((l) => l.taxable_amount)), tax_amount: addMoney(lines.map((l) => l.tax_amount)) };
  return { tax_type: template.tax_type, from: fromDate, to: toDate, jurisdiction_template: { id: template.id, code: template.code, name: template.name }, lines, totals };
}

async function jurisdictionReturn({ orgId, fromDate, toDate, templateCode, jurisdictionId = null }) {
  return buildJurisdictionReturnPayload({ orgId, fromDate, toDate, templateCode, jurisdictionId });
}

async function createJurisdictionReturn({ orgId, userId, fromDate, toDate, templateCode, jurisdictionId = null }) {
  return withTransaction(async (client) => {
    const payload = await buildJurisdictionReturnPayload({ orgId, fromDate, toDate, templateCode, jurisdictionId });
    const existing = await client.query(
      `SELECT id FROM tax_returns WHERE organization_id=$1 AND tax_type=$2 AND from_date=$3::date AND to_date=$4::date AND COALESCE(jurisdiction_id::text,'')=COALESCE($5::uuid::text,'') AND COALESCE(is_current, TRUE)=TRUE ORDER BY created_at DESC LIMIT 1`,
      [orgId, payload.tax_type, fromDate, toDate, jurisdictionId || null]
    );
    if (existing.rows[0]) {
      const upd = await client.query(`UPDATE tax_returns SET status='draft', template_id=$3, jurisdiction_id=$4, payload_json=$5::jsonb, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING id`, [orgId, existing.rows[0].id, payload.jurisdiction_template.id, jurisdictionId || null, JSON.stringify(payload)]);
      return { return_id: upd.rows[0].id, ...payload };
    }
    const ins = await client.query(`INSERT INTO tax_returns (organization_id, tax_type, from_date, to_date, status, template_id, jurisdiction_id, payload_json, created_by) VALUES ($1,$2,$3::date,$4::date,'draft',$5,$6,$7::jsonb,$8) RETURNING id`, [orgId, payload.tax_type, fromDate, toDate, payload.jurisdiction_template.id, jurisdictionId || null, JSON.stringify(payload), userId || null]);
    return { return_id: ins.rows[0]?.id, ...payload };
  });
}

async function ghanaVatReturn({ orgId, fromDate, toDate, templateCode = null }) {
  const payload = await buildVatReturnPayload({ orgId, fromDate, toDate, templateCode, includeGhanaComponents: true });
  const componentTotals = payload.transactions.reduce((acc, row) => {
    const key = row.tax_code || row.tax_type || 'UNMAPPED';
    acc[key] = money(d(acc[key] || 0).plus(d(row.signed_tax_amount)));
    return acc;
  }, {});
  return { ...payload, report_type: 'GHANA_VAT_NHIL_GETFUND', componentTotals };
}

async function ghanaVatTransactions({ orgId, fromDate, toDate }) {
  const rows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: null });
  return rows.filter(isGhanaVatRow);
}

async function ghanaVatReconciliation({ orgId, fromDate, toDate }) {
  const generic = await taxReconciliation({ orgId, fromDate, toDate, taxType: 'VAT' });
  const ghanaReturn = await ghanaVatReturn({ orgId, fromDate, toDate });
  return { ...generic, ghanaComponentTotals: ghanaReturn.componentTotals, ghanaNetTaxPayable: ghanaReturn.totals.net_tax_payable };
}

async function withholdingReport({ orgId, fromDate, toDate, mode = 'summary' }) {
  const rows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: 'WITHHOLDING' });
  const payable = rows.filter((r) => r.direction === 'output' || d(r.signed_tax_amount).greaterThanOrEqualTo(0));
  const receivable = rows.filter((r) => r.direction === 'input' || d(r.signed_tax_amount).lessThan(0));
  const bucket = mode === 'receivable' ? receivable : mode === 'payable' ? payable : rows;
  const byCode = bucket.reduce((acc, row) => {
    const key = row.tax_code || 'UNMAPPED';
    if (!acc[key]) acc[key] = { tax_code: key, tax_code_name: row.tax_code_name || key, taxable_amount: '0.00', tax_amount: '0.00', count: 0 };
    acc[key].taxable_amount = money(d(acc[key].taxable_amount).plus(d(row.signed_taxable_amount)));
    acc[key].tax_amount = money(d(acc[key].tax_amount).plus(d(row.signed_tax_amount)));
    acc[key].count += 1;
    return acc;
  }, {});
  return {
    from: fromDate,
    to: toDate,
    mode,
    totalTaxable: addMoney(bucket.map((r) => r.signed_taxable_amount)),
    totalTax: addMoney(bucket.map((r) => r.signed_tax_amount)),
    count: bucket.length,
    byTaxCode: Object.values(byCode),
    rows: bucket
  };
}

async function withholdingReconciliation({ orgId, fromDate, toDate }) {
  const report = await withholdingReport({ orgId, fromDate, toDate, mode: 'summary' });
  const rec = await taxReconciliation({ orgId, fromDate, toDate, taxType: 'WITHHOLDING' });
  return { ...rec, withholdingSummary: { totalTax: report.totalTax, totalTaxable: report.totalTaxable, count: report.count, byTaxCode: report.byTaxCode } };
}

async function listCountryPacks({ orgId }) {
  const { rows } = await pool.query(
    `SELECT p.*, i.installed_at, i.installed_by,
            CASE WHEN i.pack_id IS NULL THEN FALSE ELSE TRUE END AS is_installed
       FROM tax_country_packs p
       LEFT JOIN tax_country_pack_installs i
         ON i.pack_id = p.id AND i.organization_id = $1
      WHERE p.organization_id=$1 OR p.organization_id IS NULL
      ORDER BY is_installed DESC, p.is_active DESC, p.country_code, p.pack_code`,
    [orgId]
  );
  return rows.map(normalizeCountryPackReportRow);
}

async function listFilingAdapters({ orgId }) {
  const { rows } = await pool.query(`SELECT * FROM tax_filing_adapters WHERE organization_id=$1 ORDER BY adapter_code`, [orgId]);
  return rows;
}

async function queueFilingRun({ orgId, actorUserId, taxReturnId, adapterCode }) {
  const { rows: returnRows } = await pool.query(`SELECT * FROM tax_returns WHERE organization_id=$1 AND id=$2`, [orgId, taxReturnId]);
  const taxReturn = returnRows[0];
  if (!taxReturn) throw new AppError(404, 'Tax return not found');
  const { rows: adapterRows } = await pool.query(`SELECT * FROM tax_filing_adapters WHERE organization_id=$1 AND adapter_code=$2`, [orgId, adapterCode]);
  const adapter = adapterRows[0];
  if (!adapter) throw new AppError(404, 'Tax filing adapter not found');
  const requestPayload = { adapterCode, filingMode: adapter.filing_mode, payload: taxReturn.payload_json || {}, taxType: taxReturn.tax_type };
  const { rows } = await pool.query(`INSERT INTO tax_filing_runs(organization_id, adapter_id, tax_return_id, source_type, source_id, status, request_payload, transmitted_at) VALUES ($1,$2,$3,'tax_return',$3,'queued',$4::jsonb,NOW()) RETURNING *`, [orgId, adapter.id, taxReturnId, JSON.stringify(requestPayload)]);
  return rows[0];
}

async function listFilingRuns({ orgId, status = null }) {
  const params = [orgId];
  let sql = `SELECT * FROM tax_filing_runs WHERE organization_id=$1`;
  if (status) { params.push(status); sql += ` AND status=$2`; }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await pool.query(sql, params);
  return rows;
}

module.exports = {
  vatSummary,
  vatReturn,
  createVatReturn,
  taxTransactions,
  taxReconciliation,
  taxDiagnostics,
  listReturns,
  getReturnById,
  submitReturnForApproval,
  approveReturnWorkflow,
  rejectReturnWorkflow,
  finalizeReturn,
  jurisdictionReturn,
  createJurisdictionReturn,
  ghanaVatReturn,
  ghanaVatTransactions,
  ghanaVatReconciliation,
  withholdingReport,
  withholdingReconciliation,
  listCountryPacks,
  listFilingAdapters,
  queueFilingRun,
  listFilingRuns
};
