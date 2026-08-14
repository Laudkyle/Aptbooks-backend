const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const opsRepo = require('../../transactions/_shared/opsDocs.repository');
const { parseDecimalToBigInt, bigIntToDecimalString } = require('../../../shared/utils/money');

function addressFromJson(addressJson) {
  if (!addressJson) return null;
  return {
    label: addressJson.label || null,
    line1: addressJson.addressLine1 || null,
    line2: addressJson.addressLine2 || null,
    city: addressJson.city || null,
    region: addressJson.region || addressJson.state || null,
    postalCode: addressJson.postalCode || null,
    country: addressJson.country || null
  };
}

function addressFromRow(prefix, row) {
  return {
    label: row[`${prefix}_address_label`] || null,
    line1: row[`${prefix}_address_line1`] || null,
    line2: row[`${prefix}_address_line2`] || null,
    city: row[`${prefix}_address_city`] || null,
    region: row[`${prefix}_address_region`] || null,
    postalCode: row[`${prefix}_address_postal_code`] || null,
    country: row[`${prefix}_address_country`] || null
  };
}

async function getOrganization(orgId) {
  const { rows } = await pool.query(
    `SELECT 
       id, 
       name, 
       base_currency_code,
       contact_email,
       contact_phone,
       address_json,
       branding_json,
       logo_document_id
     FROM organizations 
     WHERE id = $1 LIMIT 1`,
    [orgId]
  );
  if (!rows.length) throw new AppError(400, 'Invalid organization');
  
  const org = rows[0];
  
  // Parse address_json if it exists
  let address = null;
  if (org.address_json && typeof org.address_json === 'object') {
    address = addressFromJson(org.address_json);
  } else if (org.address_json && typeof org.address_json === 'string') {
    try {
      address = addressFromJson(JSON.parse(org.address_json));
    } catch (e) {
      // Invalid JSON, ignore
    }
  }
  
  // Parse branding_json if it exists
  let branding = null;
  if (org.branding_json && typeof org.branding_json === 'object') {
    branding = org.branding_json;
  } else if (org.branding_json && typeof org.branding_json === 'string') {
    try {
      branding = JSON.parse(org.branding_json);
    } catch (e) {
      // Invalid JSON, ignore
    }
  }
  
  return {
    id: org.id,
    name: org.name,
    base_currency_code: org.base_currency_code,
    email: org.contact_email,
    phone: org.contact_phone,
    address,
    branding,
    logo_document_id: org.logo_document_id
  };
}

function makeMeta({ entityType, documentNo, documentDate, dueDate, status, reference, currencyCode, workflowStatus, issuedAt }) {
  return {
    entityType,
    documentNo,
    documentDate,
    dueDate: dueDate || null,
    status: status || null,
    reference: reference || null,
    currencyCode: currencyCode || null,
    workflowStatus: workflowStatus || null,
    issuedAt: issuedAt || null
  };
}



function pickFirst(row, keys) {
  for (const key of keys) {
    if (row && row[key]) return row[key];
  }
  return null;
}

async function getSignatureProfiles({ orgId, userIds = [] }) {
  const cleaned = [...new Set((userIds || []).filter(Boolean))];
  if (!cleaned.length) return new Map();
  const { rows } = await pool.query(
    `SELECT u.id AS user_id,
            u.email,
            u.first_name,
            u.last_name,
            u.full_name,
            uo.signature_image,
            uo.signature_display_name,
            uo.signature_title,
            uo.signature_notes,
            uo.signature_is_active
       FROM users u
       JOIN user_organizations uo ON uo.user_id = u.id AND uo.organization_id = $1
      WHERE u.id = ANY($2::uuid[])`,
    [orgId, cleaned]
  );
  return new Map(rows.map((r) => [r.user_id, r]));
}

function resolveUserDisplayName(profile) {
  if (!profile) return null;
  return profile.signature_display_name || [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.full_name || profile.email || null;
}

async function attachSignatureBlocks({ orgId, row, payload }) {
  if (!row || !payload) return payload;

  const candidates = [
    { key: 'preparedBy', label: 'Prepared by', userId: pickFirst(row, ['created_by_user_id', 'created_by', 'submitted_by_user_id', 'submitted_by']) },
    { key: 'approvedBy', label: 'Authorized by', userId: pickFirst(row, ['approved_by_user_id', 'approved_by', 'posted_by_user_id', 'posted_by']) },
    { key: 'receivedBy', label: 'Received by', userId: pickFirst(row, ['received_by_user_id', 'received_by']) }
  ].filter((x) => x.userId);

  const profiles = await getSignatureProfiles({ orgId, userIds: candidates.map((c) => c.userId) });
  const signatures = candidates.map((candidate) => {
    const profile = profiles.get(candidate.userId) || null;
    const image = profile?.signature_is_active ? profile.signature_image : null;
    return {
      key: candidate.key,
      label: candidate.label,
      userId: candidate.userId,
      name: resolveUserDisplayName(profile),
      title: profile?.signature_title || null,
      notes: profile?.signature_notes || null,
      image,
      hasSignature: Boolean(image)
    };
  });

  return { ...payload, signatures };
}

function makeLine(line, idx, extra = {}) {
  return {
    lineId: line.id || null,
    lineNo: line.line_no || idx + 1,
    description: line.description || null,
    quantity: line.quantity == null ? null : Number(line.quantity),
    unitPrice: line.unit_price == null ? null : Number(line.unit_price),
    amount: line.line_total == null ? null : Number(line.line_total),
    taxableAmount: line.taxable_amount == null ? null : Number(line.taxable_amount),
    taxAmount: line.tax_amount == null ? 0 : Number(line.tax_amount),
    grossAmount: extra.grossAmount == null ? (line.line_total == null ? null : Number(line.line_total) + Number(line.tax_amount || 0)) : Number(extra.grossAmount),
    taxCode: extra.taxCode || null,
    taxCodeName: extra.taxCodeName || null,
    taxRate: extra.taxRate == null ? null : Number(extra.taxRate),
    taxType: extra.taxType || null,
    taxDirection: extra.taxDirection || null,
    boxCode: extra.boxCode || null,
    taxComponents: Array.isArray(extra.taxComponents) ? extra.taxComponents : [],
    accountId: line.account_id || line.revenue_account_id || null,
    itemId: line.item_id || null,
    meta: { ...(line.meta || {}), ...(extra.meta || {}) }
  };
}

function buildTaxComponent(row) {
  return {
    id: row.id || null,
    sequenceNo: row.sequence_no == null ? null : Number(row.sequence_no),
    taxCodeId: row.tax_code_id || null,
    taxCode: row.tax_code_code || null,
    taxCodeName: row.tax_code_name || null,
    sourceTaxCodeId: row.source_tax_code_id || null,
    taxableAmount: Number(row.taxable_amount || 0),
    taxRate: Number(row.tax_rate || 0),
    taxAmount: Number(row.tax_amount || 0),
    taxType: row.tax_type || null,
    direction: row.direction || null,
    boxCode: row.box_code || null
  };
}

function summarizeTaxComponents(components = []) {
  const list = Array.isArray(components) ? components : [];
  const grouped = new Map();
  for (const component of list) {
    const key = [component.taxCode || '', component.taxCodeName || '', component.taxType || '', component.taxRate || 0, component.boxCode || ''].join('|');
    if (!grouped.has(key)) {
      grouped.set(key, {
        taxCode: component.taxCode || null,
        taxCodeName: component.taxCodeName || null,
        taxType: component.taxType || null,
        taxRate: Number(component.taxRate || 0),
        boxCode: component.boxCode || null,
        taxableAmount: 0,
        taxAmount: 0,
        componentCount: 0
      });
    }
    const bucket = grouped.get(key);
    bucket.taxableAmount += Number(component.taxableAmount || 0);
    bucket.taxAmount += Number(component.taxAmount || 0);
    bucket.componentCount += 1;
  }
  return Array.from(grouped.values()).sort((a, b) => {
    const typeA = `${a.taxType || ''} ${a.taxCode || ''}`.trim();
    const typeB = `${b.taxType || ''} ${b.taxCode || ''}`.trim();
    return typeA.localeCompare(typeB);
  });
}

function buildDocumentTaxSummary({ lines = [], docTaxTotal = 0 }) {
  const taxGroups = summarizeTaxComponents(lines.flatMap((line) => line.taxComponents || []));
  return {
    tax: Number(docTaxTotal || 0),
    taxGroups,
    taxableBase: lines.reduce((sum, line) => sum + Number(line.taxableAmount != null ? line.taxableAmount : line.amount || 0), 0),
    lineTaxTotal: lines.reduce((sum, line) => sum + Number(line.taxAmount || 0), 0),
    grossTotal: lines.reduce((sum, line) => sum + Number(line.grossAmount != null ? line.grossAmount : (line.amount || 0) + (line.taxAmount || 0)), 0)
  };
}

async function loadLineTaxDetails({ detailTable, lineIds = [] }) {
  const cleaned = [...new Set((lineIds || []).filter(Boolean))];
  if (!cleaned.length) return new Map();
  const { rows } = await pool.query(
    `SELECT d.*,
            tc.code AS tax_code_code,
            tc.name AS tax_code_name
       FROM ${detailTable} d
  LEFT JOIN tax_codes tc ON tc.id = d.tax_code_id
      WHERE d.line_id = ANY($1::uuid[])
      ORDER BY d.line_id, d.sequence_no`,
    [cleaned]
  );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.line_id)) map.set(row.line_id, []);
    map.get(row.line_id).push(buildTaxComponent(row));
  }
  return map;
}

async function buildInvoicePayload({ orgId, documentId }) {
  const { rows } = await pool.query(
    `SELECT i.*, bp.name AS partner_name, bp.email AS partner_email, bp.phone AS partner_phone,
            addr.label AS partner_address_label, addr.line1 AS partner_address_line1, addr.line2 AS partner_address_line2,
            addr.city AS partner_address_city, addr.region AS partner_address_region,
            addr.postal_code AS partner_address_postal_code, addr.country AS partner_address_country,
            LOWER(d.workflow_state_code) AS workflow_status
       FROM invoices i
  LEFT JOIN business_partners bp ON bp.id = i.customer_id
  LEFT JOIN business_partner_addresses addr ON addr.partner_id = bp.id AND addr.is_primary = TRUE
  LEFT JOIN documents d ON d.id = i.workflow_document_id AND d.organization_id = i.organization_id
      WHERE i.organization_id = $1 AND i.id = $2
      LIMIT 1`, [orgId, documentId]);
  if (!rows.length) throw new AppError(404, 'Invoice not found');
  const doc = rows[0];
  const { rows: lines } = await pool.query(
    `SELECT il.*,
            tc.code AS tax_code_code,
            tc.name AS tax_code_name,
            tc.tax_type AS tax_code_type,
            tc.direction AS tax_code_direction,
            tc.rate AS tax_code_rate,
            tc.box_code AS tax_box_code
       FROM invoice_lines il
  LEFT JOIN tax_codes tc ON tc.id = il.tax_code_id
      WHERE il.invoice_id = $1
      ORDER BY il.line_no`,
    [documentId]
  );
  const lineTaxMap = await loadLineTaxDetails({ detailTable: 'invoice_line_tax_details', lineIds: lines.map((line) => line.id) });
  const renderedLines = lines.map((line, idx) => {
    const taxComponents = lineTaxMap.get(line.id) || [];
    return makeLine(line, idx, {
      taxCode: line.tax_code_code || null,
      taxCodeName: line.tax_code_name || null,
      taxRate: line.tax_code_rate == null ? (taxComponents[0]?.taxRate ?? null) : Number(line.tax_code_rate),
      taxType: line.tax_code_type || taxComponents[0]?.taxType || null,
      taxDirection: line.tax_code_direction || taxComponents[0]?.direction || null,
      boxCode: line.tax_box_code || taxComponents[0]?.boxCode || null,
      grossAmount: Number(line.line_total || 0) + Number(line.tax_amount || 0),
      taxComponents
    });
  });
  const taxSummary = buildDocumentTaxSummary({ lines: renderedLines, docTaxTotal: doc.tax_total });
  const organization = await getOrganization(orgId);
  return attachSignatureBlocks({ orgId, row: doc, payload: {
    organization,
    meta: makeMeta({ entityType: 'invoice', documentNo: doc.invoice_no, documentDate: doc.invoice_date, dueDate: doc.due_date, status: doc.status, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status, issuedAt: doc.issued_at }),
    counterparty: { name: doc.partner_name || null, email: doc.partner_email || null, phone: doc.partner_phone || null, address: addressFromRow('partner', doc) },
    summary: {
      subtotal: Number(doc.subtotal || 0),
      tax: Number(doc.tax_total || 0),
      total: Number(doc.total || 0),
      memo: doc.memo || null,
      taxedLineCount: renderedLines.filter((line) => Number(line.taxAmount || 0) > 0).length,
      untaxedLineCount: renderedLines.filter((line) => Number(line.taxAmount || 0) <= 0).length,
      taxGroups: taxSummary.taxGroups,
      taxableBase: taxSummary.taxableBase,
      grossTotal: taxSummary.grossTotal
    },
    lines: renderedLines
  }});
}

async function buildBillPayload({ orgId, documentId }) {
  const { rows } = await pool.query(
    `SELECT b.*, bp.name AS partner_name, bp.email AS partner_email, bp.phone AS partner_phone,
            addr.label AS partner_address_label, addr.line1 AS partner_address_line1, addr.line2 AS partner_address_line2,
            addr.city AS partner_address_city, addr.region AS partner_address_region,
            addr.postal_code AS partner_address_postal_code, addr.country AS partner_address_country,
            LOWER(d.workflow_state_code) AS workflow_status
       FROM bills b
  LEFT JOIN business_partners bp ON bp.id = b.vendor_id
  LEFT JOIN business_partner_addresses addr ON addr.partner_id = bp.id AND addr.is_primary = TRUE
  LEFT JOIN documents d ON d.id = b.workflow_document_id AND d.organization_id = b.organization_id
      WHERE b.organization_id = $1 AND b.id = $2
      LIMIT 1`, [orgId, documentId]);
  if (!rows.length) throw new AppError(404, 'Bill not found');
  const doc = rows[0];
  const { rows: lines } = await pool.query(
    `SELECT bl.*,
            tc.code AS tax_code_code,
            tc.name AS tax_code_name,
            tc.tax_type AS tax_code_type,
            tc.direction AS tax_code_direction,
            tc.rate AS tax_code_rate,
            tc.box_code AS tax_box_code
       FROM bill_lines bl
  LEFT JOIN tax_codes tc ON tc.id = bl.tax_code_id
      WHERE bl.bill_id = $1
      ORDER BY bl.line_no`,
    [documentId]
  );
  const lineTaxMap = await loadLineTaxDetails({ detailTable: 'bill_line_tax_details', lineIds: lines.map((line) => line.id) });
  const renderedLines = lines.map((line, idx) => {
    const taxComponents = lineTaxMap.get(line.id) || [];
    return makeLine(line, idx, {
      taxCode: line.tax_code_code || null,
      taxCodeName: line.tax_code_name || null,
      taxRate: line.tax_code_rate == null ? (taxComponents[0]?.taxRate ?? null) : Number(line.tax_code_rate),
      taxType: line.tax_code_type || taxComponents[0]?.taxType || null,
      taxDirection: line.tax_code_direction || taxComponents[0]?.direction || null,
      boxCode: line.tax_box_code || taxComponents[0]?.boxCode || null,
      grossAmount: Number(line.line_total || 0) + Number(line.tax_amount || 0),
      taxComponents
    });
  });
  const taxSummary = buildDocumentTaxSummary({ lines: renderedLines, docTaxTotal: doc.tax_total });
  const organization = await getOrganization(orgId);
  return attachSignatureBlocks({ orgId, row: doc, payload: {
    organization,
    meta: makeMeta({ entityType: 'bill', documentNo: doc.bill_no, documentDate: doc.bill_date, dueDate: doc.due_date, status: doc.status, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status, issuedAt: doc.issued_at }),
    counterparty: { name: doc.partner_name || null, email: doc.partner_email || null, phone: doc.partner_phone || null, address: addressFromRow('partner', doc) },
    summary: {
      subtotal: Number(doc.subtotal || 0),
      tax: Number(doc.tax_total || 0),
      total: Number(doc.total || 0),
      memo: doc.memo || null,
      taxedLineCount: renderedLines.filter((line) => Number(line.taxAmount || 0) > 0).length,
      untaxedLineCount: renderedLines.filter((line) => Number(line.taxAmount || 0) <= 0).length,
      taxGroups: taxSummary.taxGroups,
      taxableBase: taxSummary.taxableBase,
      grossTotal: taxSummary.grossTotal
    },
    lines: renderedLines
  }});
}

async function buildCustomerReceiptPayload({ orgId, documentId }) {
  const { rows } = await pool.query(
    `SELECT cr.*, bp.name AS partner_name, bp.email AS partner_email, bp.phone AS partner_phone,
            addr.label AS partner_address_label, addr.line1 AS partner_address_line1, addr.line2 AS partner_address_line2,
            addr.city AS partner_address_city, addr.region AS partner_address_region,
            addr.postal_code AS partner_address_postal_code, addr.country AS partner_address_country,
            pm.name AS payment_method_name,
            coa.code AS cash_account_code, coa.name AS cash_account_name,
            LOWER(d.workflow_state_code) AS workflow_status
       FROM customer_receipts cr
  LEFT JOIN business_partners bp ON bp.id = cr.customer_id
  LEFT JOIN business_partner_addresses addr ON addr.partner_id = bp.id AND addr.is_primary = TRUE
  LEFT JOIN payment_methods pm ON pm.id = cr.payment_method_id
  LEFT JOIN chart_of_accounts coa ON coa.id = cr.cash_account_id
  LEFT JOIN documents d ON d.id = cr.workflow_document_id AND d.organization_id = cr.organization_id
      WHERE cr.organization_id = $1 AND cr.id = $2
      LIMIT 1`, [orgId, documentId]);
  if (!rows.length) throw new AppError(404, 'Receipt not found');
  const doc = rows[0];
  const { rows: lines } = await pool.query(`SELECT * FROM customer_receipt_allocations WHERE customer_receipt_id = $1 ORDER BY created_at ASC`, [documentId]);
  const organization = await getOrganization(orgId);
  return attachSignatureBlocks({ orgId, row: doc, payload: {
    organization,
    meta: makeMeta({ entityType: 'receipt', documentNo: doc.receipt_no, documentDate: doc.receipt_date, status: doc.status, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status, issuedAt: doc.posted_at }),
    counterparty: { name: doc.partner_name || null, email: doc.partner_email || null, phone: doc.partner_phone || null, address: addressFromRow('partner', doc) },
    summary: {
      subtotal: Number(doc.amount_total || 0),
      total: Number(doc.amount_total || 0),
      memo: doc.memo || null,
      paymentMethodName: doc.payment_method_name || null,
      cashAccount: doc.cash_account_code ? `${doc.cash_account_code} - ${doc.cash_account_name}` : null,
      discountTotal: Number(doc.discount_total || 0),
      settlementTotal: Number(doc.settlement_total || 0),
      unappliedAmount: Number(doc.unapplied_amount || 0)
    },
    lines: lines.map((line, idx) => ({
      lineNo: idx + 1,
      description: `Invoice allocation ${line.invoice_id}`,
      quantity: null,
      unitPrice: null,
      amount: Number((line.amount_applied || 0)),
      meta: { invoiceId: line.invoice_id, discountTaken: Number(line.discount_taken || 0) }
    }))
  }});
}

async function buildVendorPaymentPayload({ orgId, documentId }) {
  const { rows } = await pool.query(
    `SELECT vp.*, bp.name AS partner_name, bp.email AS partner_email, bp.phone AS partner_phone,
            addr.label AS partner_address_label, addr.line1 AS partner_address_line1, addr.line2 AS partner_address_line2,
            addr.city AS partner_address_city, addr.region AS partner_address_region,
            addr.postal_code AS partner_address_postal_code, addr.country AS partner_address_country,
            pm.name AS payment_method_name,
            coa.code AS cash_account_code, coa.name AS cash_account_name,
            LOWER(d.workflow_state_code) AS workflow_status
       FROM vendor_payments vp
  LEFT JOIN business_partners bp ON bp.id = vp.vendor_id
  LEFT JOIN business_partner_addresses addr ON addr.partner_id = bp.id AND addr.is_primary = TRUE
  LEFT JOIN payment_methods pm ON pm.id = vp.payment_method_id
  LEFT JOIN chart_of_accounts coa ON coa.id = vp.cash_account_id
  LEFT JOIN documents d ON d.id = vp.workflow_document_id AND d.organization_id = vp.organization_id
      WHERE vp.organization_id = $1 AND vp.id = $2
      LIMIT 1`, [orgId, documentId]);
  if (!rows.length) throw new AppError(404, 'Vendor payment not found');
  const doc = rows[0];
  const { rows: lines } = await pool.query(`SELECT * FROM vendor_payment_allocations WHERE vendor_payment_id = $1 ORDER BY created_at ASC`, [documentId]);
  const organization = await getOrganization(orgId);
  return attachSignatureBlocks({ orgId, row: doc, payload: {
    organization,
    meta: makeMeta({ entityType: 'payment_out', documentNo: doc.payment_no, documentDate: doc.payment_date, status: doc.status, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status, issuedAt: doc.posted_at }),
    counterparty: { name: doc.partner_name || null, email: doc.partner_email || null, phone: doc.partner_phone || null, address: addressFromRow('partner', doc) },
    summary: {
      subtotal: Number(doc.amount_total || 0),
      total: Number(doc.amount_total || 0),
      memo: doc.memo || null,
      paymentMethodName: doc.payment_method_name || null,
      cashAccount: doc.cash_account_code ? `${doc.cash_account_code} - ${doc.cash_account_name}` : null
    },
    lines: lines.map((line, idx) => ({
      lineNo: idx + 1,
      description: `Bill allocation ${line.bill_id}`,
      quantity: null,
      unitPrice: null,
      amount: Number((line.amount_applied || 0)),
      meta: { billId: line.bill_id, discountTaken: Number(line.discount_taken || 0) }
    }))
  }});
}

async function buildCreditNotePayload({ orgId, documentId }) {
  const { rows } = await pool.query(
    `SELECT cn.*, bp.name AS partner_name, bp.email AS partner_email, bp.phone AS partner_phone,
            addr.label AS partner_address_label, addr.line1 AS partner_address_line1, addr.line2 AS partner_address_line2,
            addr.city AS partner_address_city, addr.region AS partner_address_region,
            addr.postal_code AS partner_address_postal_code, addr.country AS partner_address_country,
            LOWER(d.workflow_state_code) AS workflow_status
       FROM credit_notes cn
  LEFT JOIN business_partners bp ON bp.id = cn.customer_id
  LEFT JOIN business_partner_addresses addr ON addr.partner_id = bp.id AND addr.is_primary = TRUE
  LEFT JOIN documents d ON d.id = cn.workflow_document_id AND d.organization_id = cn.organization_id
      WHERE cn.organization_id = $1 AND cn.id = $2
      LIMIT 1`, [orgId, documentId]);
  if (!rows.length) throw new AppError(404, 'Credit note not found');
  const doc = rows[0];
  const { rows: lines } = await pool.query(`SELECT * FROM credit_note_lines WHERE credit_note_id = $1 ORDER BY line_no`, [documentId]);
  const organization = await getOrganization(orgId);
  return attachSignatureBlocks({ orgId, row: doc, payload: {
    organization,
    meta: makeMeta({ entityType: 'credit_note', documentNo: doc.credit_note_no || doc.note_no || doc.id, documentDate: doc.credit_note_date || doc.note_date, status: doc.status, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status, issuedAt: doc.issued_at }),
    counterparty: { name: doc.partner_name || null, email: doc.partner_email || null, phone: doc.partner_phone || null, address: addressFromRow('partner', doc) },
    summary: { subtotal: Number(doc.subtotal || 0), total: Number(doc.total || 0), memo: doc.memo || null },
    lines: lines.map(makeLine)
  }});
}

async function buildDebitNotePayload({ orgId, documentId }) {
  const { rows } = await pool.query(
    `SELECT dn.*, bp.name AS partner_name, bp.email AS partner_email, bp.phone AS partner_phone,
            addr.label AS partner_address_label, addr.line1 AS partner_address_line1, addr.line2 AS partner_address_line2,
            addr.city AS partner_address_city, addr.region AS partner_address_region,
            addr.postal_code AS partner_address_postal_code, addr.country AS partner_address_country,
            LOWER(d.workflow_state_code) AS workflow_status
       FROM debit_notes dn
  LEFT JOIN business_partners bp ON bp.id = dn.vendor_id
  LEFT JOIN business_partner_addresses addr ON addr.partner_id = bp.id AND addr.is_primary = TRUE
  LEFT JOIN documents d ON d.id = dn.workflow_document_id AND d.organization_id = dn.organization_id
      WHERE dn.organization_id = $1 AND dn.id = $2
      LIMIT 1`, [orgId, documentId]);
  if (!rows.length) throw new AppError(404, 'Debit note not found');
  const doc = rows[0];
  const { rows: lines } = await pool.query(`SELECT * FROM debit_note_lines WHERE debit_note_id = $1 ORDER BY line_no`, [documentId]);
  const organization = await getOrganization(orgId);
  return attachSignatureBlocks({ orgId, row: doc, payload: {
    organization,
    meta: makeMeta({ entityType: 'debit_note', documentNo: doc.debit_note_no || doc.note_no || doc.id, documentDate: doc.debit_note_date || doc.note_date, status: doc.status, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status, issuedAt: doc.issued_at }),
    counterparty: { name: doc.partner_name || null, email: doc.partner_email || null, phone: doc.partner_phone || null, address: addressFromRow('partner', doc) },
    summary: { subtotal: Number(doc.subtotal || 0), total: Number(doc.total || 0), memo: doc.memo || null },
    lines: lines.map(makeLine)
  }});
}


async function buildJournalPayload({ orgId, documentId }) {
  const { rows } = await pool.query(
    `SELECT je.*, jet.code AS journal_type_code
       FROM journal_entries je
       LEFT JOIN journal_entry_types jet ON jet.id=je.journal_entry_type_id
      WHERE je.organization_id=$1 AND je.id=$2
      LIMIT 1`,
    [orgId, documentId]
  );
  if (!rows.length) throw new AppError(404, 'Journal entry not found');
  const doc = rows[0];
  const { rows: lines } = await pool.query(
    `SELECT jel.*, coa.code AS account_code, coa.name AS account_name
       FROM journal_entry_lines jel
       JOIN chart_of_accounts coa
         ON coa.id=jel.account_id AND coa.organization_id=$1
      WHERE jel.journal_entry_id=$2
      ORDER BY jel.line_no`,
    [orgId, documentId]
  );
  const organization = await getOrganization(orgId);
  const debitTotalCents = lines.reduce((sum, line) => sum + (parseDecimalToBigInt(line.debit || 0, 2) > 0n ? parseDecimalToBigInt(line.amount_base || 0, 2) : 0n), 0n);
  const creditTotalCents = lines.reduce((sum, line) => sum + (parseDecimalToBigInt(line.credit || 0, 2) > 0n ? parseDecimalToBigInt(line.amount_base || 0, 2) : 0n), 0n);
  const debitTotal = bigIntToDecimalString(debitTotalCents, 2);
  const creditTotal = bigIntToDecimalString(creditTotalCents, 2);
  const difference = bigIntToDecimalString(debitTotalCents >= creditTotalCents ? debitTotalCents - creditTotalCents : creditTotalCents - debitTotalCents, 2);
  const payload = {
    organization,
    meta: makeMeta({
      entityType: 'journal_entry',
      documentNo: doc.entry_no || doc.id,
      documentDate: doc.entry_date,
      status: doc.status,
      reference: doc.journal_type_code || null,
      currencyCode: organization.base_currency_code,
      workflowStatus: doc.status
    }),
    counterparty: null,
    summary: {
      subtotal: debitTotal,
      total: debitTotal,
      debitTotal,
      creditTotal,
      balanced: debitTotalCents === creditTotalCents,
      difference,
      memo: doc.memo || null
    },
    lines: lines.map((line, idx) => ({
      lineId: line.id,
      lineNo: line.line_no || idx + 1,
      accountId: line.account_id,
      accountCode: line.account_code,
      accountName: line.account_name,
      description: line.description || null,
      debit: parseDecimalToBigInt(line.debit || 0, 2) > 0n ? String(line.amount_base || '0.00') : '0.00',
      credit: parseDecimalToBigInt(line.credit || 0, 2) > 0n ? String(line.amount_base || '0.00') : '0.00',
      transactionDebit: String(line.debit || '0.00'),
      transactionCredit: String(line.credit || '0.00'),
      currencyCode: line.currency_code || organization.base_currency_code,
      fxRate: line.fx_rate == null ? null : String(line.fx_rate),
      amountBase: String(line.amount_base || '0.00')
    }))
  };
  return attachSignatureBlocks({ orgId, row: doc, payload });
}

const OPS_MODULE_MAP = {
  quotation: 'quotations',
  sales_order: 'sales_orders',
  purchase_requisition: 'purchase_requisitions',
  purchase_order: 'purchase_orders',
  goods_receipt: 'goods_receipts',
  expense: 'expenses',
  petty_cash: 'petty_cash',
  advance: 'advances',
  return: 'returns',
  refund: 'refunds'
};

async function buildOpsDocPayload({ orgId, documentId, entityType }) {
  const moduleCode = OPS_MODULE_MAP[entityType];
  if (!moduleCode) throw new AppError(400, 'Unsupported operational document type');
  const doc = await opsRepo.getDocumentById(orgId, documentId, null);
  if (!doc || doc.module_code !== moduleCode) throw new AppError(404, 'Operational document not found');
  const lines = await opsRepo.getDocumentLines(documentId);
  const organization = await getOrganization(orgId);
  const counterpartyName = doc.partner_name || [doc.employee_first_name, doc.employee_last_name].filter(Boolean).join(' ') || null;
  return attachSignatureBlocks({ orgId, row: doc, payload: {
    organization,
    meta: makeMeta({ entityType, documentNo: doc.document_no, documentDate: doc.document_date, dueDate: doc.due_date, status: doc.status, reference: doc.reference, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status }),
    counterparty: { name: counterpartyName, email: null, phone: null, address: null },
    summary: { subtotal: Number(doc.amount_total || 0), total: Number(doc.amount_total || 0), memo: doc.memo || null },
    lines: lines.map(makeLine)
  }});
}

async function buildPayload({ orgId, entityType, documentId }) {
  switch (entityType) {
    case 'journal_entry': return buildJournalPayload({ orgId, documentId });
    case 'invoice': return buildInvoicePayload({ orgId, documentId });
    case 'bill': return buildBillPayload({ orgId, documentId });
    case 'receipt': return buildCustomerReceiptPayload({ orgId, documentId });
    case 'payment_out': return buildVendorPaymentPayload({ orgId, documentId });
    case 'credit_note': return buildCreditNotePayload({ orgId, documentId });
    case 'debit_note': return buildDebitNotePayload({ orgId, documentId });
    case 'quotation':
    case 'sales_order':
    case 'purchase_requisition':
    case 'purchase_order':
    case 'goods_receipt':
    case 'expense':
    case 'petty_cash':
    case 'advance':
    case 'return':
    case 'refund':
      return buildOpsDocPayload({ orgId, documentId, entityType });
    default:
      throw new AppError(400, `Unsupported printable document type: ${entityType}`);
  }
}

function samplePayload(entityType = 'invoice') {
  return {
    organization: { 
      name: 'Your Organization', 
      base_currency_code: 'GHS', 
      email: 'finance@example.com', 
      phone: '+233000000000',
      address: {
        line1: '123 Main Street',
        city: 'Accra',
        country: 'Ghana'
      }
    },
    meta: { entityType, documentNo: 'DOC-000001', documentDate: '2026-03-20', dueDate: '2026-03-27', status: 'issued', reference: 'REF-001', currencyCode: 'GHS', workflowStatus: 'approved' },
    counterparty: { name: 'Sample Counterparty Ltd', email: 'accounts@example.com', phone: '+233000000111', address: { line1: '123 Sample Street', city: 'Accra', country: 'Ghana' } },
    summary: { subtotal: 1250.00, total: 1250.00, memo: 'Sample generated preview payload.', paymentMethodName: 'Bank Transfer', cashAccount: '1010 - Main Bank' },
    lines: [
      { lineNo: 1, description: 'Sample line 1', quantity: 2, unitPrice: 250, amount: 500 },
      { lineNo: 2, description: 'Sample line 2', quantity: 3, unitPrice: 250, amount: 750 }
    ],
    signatures: [
      { key: 'preparedBy', label: 'Prepared by', name: 'Finance Officer', title: 'Accounts Officer', image: null, hasSignature: false },
      { key: 'approvedBy', label: 'Authorized by', name: 'Finance Manager', title: 'Finance Manager', image: null, hasSignature: false }
    ]
  };
}

module.exports = { buildPayload, samplePayload };