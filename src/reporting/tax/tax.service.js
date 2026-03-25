const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const { withTransaction } = require("../../db/tx");
const documentableSvc = require("../../workflow/documents/documentable.service");

function assertIsoDate(d, field) {
  if (!d || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d)) {
    throw new AppError(400, `${field} must be YYYY-MM-DD`);
  }
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
             ta.direction, ta.box_code,
             CASE WHEN ta.amount < 0 THEN -1::numeric ELSE 1::numeric END
      FROM tax_adjustments ta
      WHERE ta.organization_id=$1 AND ta.status='posted' AND ta.adjustment_date BETWEEN $2::date AND $3::date
    )
    SELECT entity_type, entity_id, document_no, document_date, status, partner_id, partner_name,
           line_id, line_no, description, taxable_amount, tax_amount, tax_code_id, tax_code, tax_code_name,
           tax_type, direction, box_code, sign_factor,
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
    taxable_amount: Number(r.taxable_amount || 0),
    tax_amount: Number(r.tax_amount || 0),
    signed_taxable_amount: Number(r.signed_taxable_amount || 0),
    signed_tax_amount: Number(r.signed_tax_amount || 0)
  }));
}

async function vatSummary({ orgId, fromDate, toDate }) {
  const rows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: 'VAT' });
  const outputTax = rows.filter((r) => r.direction === 'output').reduce((s, r) => s + Number(r.signed_tax_amount || 0), 0);
  const inputTax = rows.filter((r) => r.direction === 'input').reduce((s, r) => s + Number(r.signed_tax_amount || 0), 0);
  return {
    from: fromDate,
    to: toDate,
    outputTax: Number(outputTax.toFixed(2)),
    inputTax: Number(inputTax.toFixed(2)),
    netTaxPayable: Number((outputTax - inputTax).toFixed(2)),
    sourceBreakdown: rows.reduce((acc, row) => {
      acc[row.entity_type] = Number(((acc[row.entity_type] || 0) + row.signed_tax_amount).toFixed(2));
      return acc;
    }, {})
  };
}

async function vatReturn({ orgId, userId, fromDate, toDate, templateCode }) {
  assertIsoDate(fromDate, "from");
  assertIsoDate(toDate, "to");
  if (toDate < fromDate) throw new AppError(400, "to must be on or after from");

  let template = null;
  if (templateCode) {
    const { rows } = await pool.query(`SELECT id, code, name FROM tax_return_templates WHERE organization_id=$1 AND tax_type='VAT' AND code=$2`, [orgId, templateCode]);
    template = rows[0] || null;
    if (!template) throw new AppError(404, "Tax return template not found");
  } else {
    const { rows } = await pool.query(`SELECT id, code, name FROM tax_return_templates WHERE organization_id=$1 AND tax_type='VAT' ORDER BY code LIMIT 1`, [orgId]);
    template = rows[0] || null;
  }

  let templateBoxes = [];
  if (template) {
    const { rows } = await pool.query(`SELECT box_code, label, sort_order, direction FROM tax_return_template_boxes WHERE template_id=$1 ORDER BY sort_order, box_code`, [template.id]);
    templateBoxes = rows;
  }

  const rows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: 'VAT' });
  const byBox = new Map();
  for (const row of rows) {
    if (!row.box_code) continue;
    const key = `${row.box_code}::${row.direction}`;
    byBox.set(key, Number(((byBox.get(key) || 0) + Number(row.signed_tax_amount || 0)).toFixed(2)));
  }

  const fallbackBoxes = Array.from(new Set(rows.filter((r) => r.box_code).map((r) => `${r.box_code}::${r.direction}`))).map((k) => {
    const [box_code, direction] = k.split('::');
    return { box_code, label: box_code, sort_order: 0, direction };
  });

  const boxes = (templateBoxes.length ? templateBoxes : fallbackBoxes).map((b) => ({
    box_code: b.box_code,
    label: b.label,
    direction: b.direction || null,
    amount: Number((byBox.get(`${b.box_code}::${b.direction || 'output'}`) || byBox.get(`${b.box_code}::${b.direction || 'input'}`) || 0).toFixed(2))
  }));

  const outputTotal = boxes.filter((b) => (b.direction || 'output') === 'output').reduce((s, b) => s + Number(b.amount || 0), 0);
  const inputTotal = boxes.filter((b) => (b.direction || 'input') === 'input').reduce((s, b) => s + Number(b.amount || 0), 0);
  const netPayable = outputTotal - inputTotal;

  const payload = {
    tax_type: 'VAT',
    from: fromDate,
    to: toDate,
    template: template ? { id: template.id, code: template.code, name: template.name } : null,
    boxes,
    totals: {
      output_tax: Number(outputTotal.toFixed(2)),
      input_tax: Number(inputTotal.toFixed(2)),
      net_tax_payable: Number(netPayable.toFixed(2))
    },
    coverage: {
      transaction_count: rows.length,
      source_types: Array.from(new Set(rows.map((r) => r.entity_type))).sort()
    }
  };

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

async function taxTransactions({ orgId, fromDate, toDate, taxType, direction, entityType }) {
  let rows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: taxType || null });
  if (direction) rows = rows.filter((r) => r.direction === direction);
  if (entityType) rows = rows.filter((r) => r.entity_type === entityType);
  return rows;
}

async function taxReconciliation({ orgId, fromDate, toDate, taxType }) {
  assertIsoDate(fromDate, "from");
  assertIsoDate(toDate, "to");
  const effectiveTaxType = taxType || 'VAT';
  const rows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: effectiveTaxType || null });
  const bySource = {};
  const byBox = {};
  const issueItems = [];
  for (const row of rows) {
    const sourceKey = `${row.entity_type}::${row.direction}`;
    bySource[sourceKey] = Number(((bySource[sourceKey] || 0) + row.signed_tax_amount).toFixed(2));
    if (row.box_code) {
      const boxKey = `${row.box_code}::${row.direction}`;
      byBox[boxKey] = Number(((byBox[boxKey] || 0) + row.signed_tax_amount).toFixed(2));
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
              SUM(jel.debit) AS debit_total, SUM(jel.credit) AS credit_total,
              SUM(jel.debit - jel.credit) AS net_amount
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
    glRows = gl.rows.map((r) => ({
      ...r,
      debit_total: Number(r.debit_total || 0),
      credit_total: Number(r.credit_total || 0),
      net_amount: Number(r.net_amount || 0)
    }));
  }

  const sourceOutput = Number(rows.filter((r) => r.direction === 'output').reduce((s, r) => s + r.signed_tax_amount, 0).toFixed(2));
  const sourceInput = Number(rows.filter((r) => r.direction === 'input').reduce((s, r) => s + r.signed_tax_amount, 0).toFixed(2));
  const expectedNet = Number((sourceInput - sourceOutput).toFixed(2));
  const glNet = Number(glRows.reduce((s, r) => s + r.net_amount, 0).toFixed(2));
  const difference = Number((glNet - expectedNet).toFixed(2));

  const summary = {
    from: fromDate,
    to: toDate,
    taxType: effectiveTaxType,
    transactionCount: rows.length,
    bySource,
    byBox,
    sourceTotals: {
      outputTax: sourceOutput,
      inputTax: sourceInput,
      expectedNetTaxAssetLiability: expectedNet
    },
    glTotals: {
      taxAccountCount: glRows.length,
      netAmount: glNet,
      accounts: glRows
    },
    difference,
    status: Math.abs(difference) < 0.01 && issueItems.length === 0 ? 'balanced' : 'attention_required',
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
        `INSERT INTO tax_reconciliation_items (run_id, entity_type, entity_id, issue_code, details_json)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
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
  if (!['VAT','GST','SALES'].includes(t)) throw new AppError(400, "taxType must be VAT, GST, or SALES");

  const params = [orgId, t];
  let where = "";
  if (fromDate) { assertIsoDate(fromDate, "from"); params.push(fromDate); where += ` AND tr.from_date >= $${params.length}::date`; }
  if (toDate) { assertIsoDate(toDate, "to"); params.push(toDate); where += ` AND tr.to_date <= $${params.length}::date`; }

  const { rows } = await pool.query(
    `SELECT tr.id, tr.tax_type, tr.from_date, tr.to_date, tr.status, tr.workflow_status, tr.workflow_document_id, tr.created_at, tr.finalized_at, tr.template_id FROM tax_returns tr WHERE tr.organization_id=$1 AND tr.tax_type=$2 ${where} ORDER BY tr.from_date DESC, tr.created_at DESC`,
    params
  );

  return rows.map((r) => ({ id: r.id, tax_type: r.tax_type, from: r.from_date, to: r.to_date, status: r.status, workflow_status: r.workflow_status, workflow_document_id: r.workflow_document_id, created_at: r.created_at, finalized_at: r.finalized_at, template_id: r.template_id }));
}


async function jurisdictionReturn({ orgId, userId, fromDate, toDate, templateCode, jurisdictionId = null }) {
  assertIsoDate(fromDate, 'from');
  assertIsoDate(toDate, 'to');
  const params = [orgId];
  let sql = `SELECT * FROM tax_return_jurisdiction_templates WHERE organization_id=$1`;
  if (templateCode) {
    params.append(templateCode);
    sql += ` AND code=$${len(params)}`;
  }
  if (jurisdictionId) {
    params.append(jurisdictionId);
    sql += ` AND jurisdiction_id=$${len(params)}`;
  }
  sql += ' ORDER BY updated_at DESC LIMIT 1';
  const tplRows = await pool.query(sql, params);
  const template = tplRows.rows[0];
  if (!template) throw new AppError(404, 'Jurisdiction return template not found');

  const boxRows = await pool.query(`SELECT * FROM tax_return_jurisdiction_boxes WHERE template_id=$1 ORDER BY sort_order, box_code`, [template.id]);
  const txRows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: template.tax_type || 'VAT' });
  const lines = boxRows.rows.map((box) => {
    const filtered = txRows.filter((r) => (!box.direction || r.direction === box.direction) && (!box.tax_scope || (r.tax_scope || '') === box.tax_scope) && (!box.box_code || r.box_code === box.box_code));
    const taxAmount = filtered.reduce((s, r) => s + Number(r.signed_tax_amount || 0), 0);
    const taxableAmount = filtered.reduce((s, r) => s + Number(r.signed_taxable_amount || 0), 0);
    return { box_code: box.box_code, label: box.label, direction: box.direction || null, taxable_amount: Number(taxableAmount.toFixed(2)), tax_amount: Number(taxAmount.toFixed(2)), transaction_count: filtered.length };
  });
  const totals = { taxable_amount: Number(lines.reduce((s, l) => s + l.taxable_amount, 0).toFixed(2)), tax_amount: Number(lines.reduce((s, l) => s + l.tax_amount, 0).toFixed(2)) };
  const payload = { tax_type: template.tax_type, from: fromDate, to: toDate, jurisdiction_template: { id: template.id, code: template.code, name: template.name }, lines, totals };
  const { rows } = await pool.query(`INSERT INTO tax_returns (organization_id, tax_type, from_date, to_date, status, template_id, payload_json, created_by) VALUES ($1,$2,$3::date,$4::date,'draft',$5,$6::jsonb,$7) RETURNING id`, [orgId, template.tax_type, fromDate, toDate, template.id, JSON.stringify(payload), userId || null]);
  return { return_id: rows[0]?.id, ...payload };
}

async function listCountryPacks({ orgId }) {
  const { rows } = await pool.query(`SELECT * FROM tax_country_packs WHERE organization_id=$1 OR organization_id IS NULL ORDER BY country_code, pack_code`, [orgId]);
  return rows;
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
  listCountryPacks,
  listFilingAdapters,
  queueFilingRun,
  listFilingRuns
};
