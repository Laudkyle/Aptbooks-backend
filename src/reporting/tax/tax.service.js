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
             COALESCE(il.line_total - COALESCE(il.tax_amount,0), il.line_total, 0) AS taxable_amount,
             COALESCE(il.tax_amount,0) AS tax_amount,
             tc.id AS tax_code_id, tc.code AS tax_code, tc.name AS tax_code_name, tc.tax_type,
             COALESCE(tc.direction,'output') AS direction, tc.box_code,
             1::numeric AS sign_factor
      FROM invoices i
      JOIN invoice_lines il ON il.invoice_id = i.id
      LEFT JOIN tax_codes tc ON tc.id = il.tax_code_id
      LEFT JOIN business_partners bp ON bp.id = i.customer_id
      WHERE i.organization_id=$1 AND i.status IN ('issued','paid') AND i.invoice_date BETWEEN $2::date AND $3::date

      UNION ALL
      SELECT 'bill', b.id, b.bill_no, b.bill_date, b.status,
             b.vendor_id, bp.name,
             bl.id, bl.line_no, bl.description,
             COALESCE(bl.line_total - COALESCE(bl.tax_amount,0), bl.line_total, 0),
             COALESCE(bl.tax_amount,0),
             tc.id, tc.code, tc.name, tc.tax_type,
             COALESCE(tc.direction,'input'), tc.box_code,
             1::numeric
      FROM bills b
      JOIN bill_lines bl ON bl.bill_id = b.id
      LEFT JOIN tax_codes tc ON tc.id = bl.tax_code_id
      LEFT JOIN business_partners bp ON bp.id = b.vendor_id
      WHERE b.organization_id=$1 AND b.status IN ('issued','paid') AND b.bill_date BETWEEN $2::date AND $3::date

      UNION ALL
      SELECT 'credit_note', cn.id, cn.credit_note_no, cn.credit_note_date, cn.status,
             cn.customer_id, bp.name,
             cnl.id, cnl.line_no, cnl.description,
             COALESCE(cnl.line_total,0),
             COALESCE(cnl.tax_amount,0),
             tc.id, tc.code, tc.name, tc.tax_type,
             COALESCE(tc.direction,'output'), tc.box_code,
             -1::numeric
      FROM credit_notes cn
      JOIN credit_note_lines cnl ON cnl.credit_note_id = cn.id
      LEFT JOIN tax_codes tc ON tc.id = cnl.tax_code_id
      LEFT JOIN business_partners bp ON bp.id = cn.customer_id
      WHERE cn.organization_id=$1 AND cn.status='issued' AND cn.credit_note_date BETWEEN $2::date AND $3::date

      UNION ALL
      SELECT 'debit_note', dn.id, dn.debit_note_no, dn.debit_note_date, dn.status,
             dn.vendor_id, bp.name,
             dnl.id, dnl.line_no, dnl.description,
             COALESCE(dnl.line_total,0),
             COALESCE(dnl.tax_amount,0),
             tc.id, tc.code, tc.name, tc.tax_type,
             COALESCE(tc.direction,'input'), tc.box_code,
             -1::numeric
      FROM debit_notes dn
      JOIN debit_note_lines dnl ON dnl.debit_note_id = dn.id
      LEFT JOIN tax_codes tc ON tc.id = dnl.tax_code_id
      LEFT JOIN business_partners bp ON bp.id = dn.vendor_id
      WHERE dn.organization_id=$1 AND dn.status='issued' AND dn.debit_note_date BETWEEN $2::date AND $3::date

      UNION ALL
      SELECT od.module_code AS entity_type, od.id AS entity_id, od.document_no,
             od.document_date, od.status,
             od.counterparty_partner_id, bp.name,
             odl.id, odl.line_no, odl.description,
             COALESCE(odl.taxable_amount, GREATEST(COALESCE(odl.line_total,0) - COALESCE(odl.tax_amount,0), 0)),
             COALESCE(odl.tax_amount,0),
             tc.id, tc.code, tc.name, tc.tax_type,
             CASE
               WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','')='sales_return' THEN 'output'
               WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','')='purchase_return' THEN 'input'
               ELSE COALESCE(tc.direction,'input')
             END AS direction,
             tc.box_code,
             CASE
               WHEN od.module_code='return' AND COALESCE(od.meta->>'returnType','') IN ('sales_return','purchase_return') THEN -1::numeric
               ELSE 1::numeric
             END AS sign_factor
      FROM operational_documents od
      JOIN operational_document_lines odl ON odl.document_id = od.id
      LEFT JOIN tax_codes tc ON tc.id = odl.tax_code_id
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
  const rows = await getTaxTransactionRows({ orgId, fromDate, toDate, taxType: taxType || null });
  const bySource = {};
  const byBox = {};
  for (const row of rows) {
    const sourceKey = `${row.entity_type}::${row.direction}`;
    bySource[sourceKey] = Number(((bySource[sourceKey] || 0) + row.signed_tax_amount).toFixed(2));
    if (row.box_code) {
      const boxKey = `${row.box_code}::${row.direction}`;
      byBox[boxKey] = Number(((byBox[boxKey] || 0) + row.signed_tax_amount).toFixed(2));
    }
  }
  return {
    from: fromDate,
    to: toDate,
    transactionCount: rows.length,
    bySource,
    byBox,
    totals: {
      outputTax: Number(rows.filter((r) => r.direction === 'output').reduce((s, r) => s + r.signed_tax_amount, 0).toFixed(2)),
      inputTax: Number(rows.filter((r) => r.direction === 'input').reduce((s, r) => s + r.signed_tax_amount, 0).toFixed(2))
    }
  };
}

async function taxDiagnostics({ orgId, fromDate, toDate }) {
  assertIsoDate(fromDate, "from");
  assertIsoDate(toDate, "to");
  const { rows } = await pool.query(
    `
    WITH src AS (
      SELECT 'invoice'::text AS entity_type, i.id AS entity_id, i.invoice_no AS document_no, i.invoice_date AS document_date,
             il.line_no, il.description, il.tax_code_id, il.tax_amount, tc.box_code, tc.direction, tc.tax_type
      FROM invoices i
      JOIN invoice_lines il ON il.invoice_id=i.id
      LEFT JOIN tax_codes tc ON tc.id = il.tax_code_id
      WHERE i.organization_id=$1 AND i.status IN ('issued','paid') AND i.invoice_date BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT 'bill', b.id, b.bill_no, b.bill_date,
             bl.line_no, bl.description, bl.tax_code_id, bl.tax_amount, tc.box_code, tc.direction, tc.tax_type
      FROM bills b
      JOIN bill_lines bl ON bl.bill_id=b.id
      LEFT JOIN tax_codes tc ON tc.id = bl.tax_code_id
      WHERE b.organization_id=$1 AND b.status IN ('issued','paid') AND b.bill_date BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT od.module_code, od.id, od.document_no, od.document_date,
             odl.line_no, odl.description, odl.tax_code_id, odl.tax_amount, tc.box_code, tc.direction, tc.tax_type
      FROM operational_documents od
      JOIN operational_document_lines odl ON odl.document_id = od.id
      LEFT JOIN tax_codes tc ON tc.id = odl.tax_code_id
      WHERE od.organization_id=$1 AND od.status='posted' AND od.module_code IN ('expense','petty_cash','return') AND od.document_date BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT 'credit_note', cn.id, cn.credit_note_no, cn.credit_note_date,
             cnl.line_no, cnl.description, cnl.tax_code_id, cnl.tax_amount, tc.box_code, tc.direction, tc.tax_type
      FROM credit_notes cn
      JOIN credit_note_lines cnl ON cnl.credit_note_id = cn.id
      LEFT JOIN tax_codes tc ON tc.id = cnl.tax_code_id
      WHERE cn.organization_id=$1 AND cn.status='issued' AND cn.credit_note_date BETWEEN $2::date AND $3::date
      UNION ALL
      SELECT 'debit_note', dn.id, dn.debit_note_no, dn.debit_note_date,
             dnl.line_no, dnl.description, dnl.tax_code_id, dnl.tax_amount, tc.box_code, tc.direction, tc.tax_type
      FROM debit_notes dn
      JOIN debit_note_lines dnl ON dnl.debit_note_id = dn.id
      LEFT JOIN tax_codes tc ON tc.id = dnl.tax_code_id
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
  finalizeReturn
};
