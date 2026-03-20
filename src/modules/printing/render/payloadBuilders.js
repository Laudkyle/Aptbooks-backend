
const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const opsRepo = require('../../transactions/_shared/opsDocs.repository');

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
    `SELECT id, name, base_currency_code, email, phone FROM organizations WHERE id = $1 LIMIT 1`,
    [orgId]
  );
  if (!rows.length) throw new AppError(400, 'Invalid organization');
  return rows[0];
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

function makeLine(line, idx) {
  return {
    lineNo: line.line_no || idx + 1,
    description: line.description || null,
    quantity: line.quantity == null ? null : Number(line.quantity),
    unitPrice: line.unit_price == null ? null : Number(line.unit_price),
    amount: line.line_total == null ? null : Number(line.line_total),
    accountId: line.account_id || line.revenue_account_id || null,
    itemId: line.item_id || null,
    meta: line.meta || {}
  };
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
  const { rows: lines } = await pool.query(`SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`, [documentId]);
  const organization = await getOrganization(orgId);
  return {
    organization,
    meta: makeMeta({ entityType: 'invoice', documentNo: doc.invoice_no, documentDate: doc.invoice_date, dueDate: doc.due_date, status: doc.status, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status, issuedAt: doc.issued_at }),
    counterparty: { name: doc.partner_name || null, email: doc.partner_email || null, phone: doc.partner_phone || null, address: addressFromRow('partner', doc) },
    summary: { subtotal: Number(doc.subtotal || 0), total: Number(doc.total || 0), memo: doc.memo || null },
    lines: lines.map(makeLine)
  };
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
  const { rows: lines } = await pool.query(`SELECT * FROM bill_lines WHERE bill_id = $1 ORDER BY line_no`, [documentId]);
  const organization = await getOrganization(orgId);
  return {
    organization,
    meta: makeMeta({ entityType: 'bill', documentNo: doc.bill_no, documentDate: doc.bill_date, dueDate: doc.due_date, status: doc.status, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status, issuedAt: doc.issued_at }),
    counterparty: { name: doc.partner_name || null, email: doc.partner_email || null, phone: doc.partner_phone || null, address: addressFromRow('partner', doc) },
    summary: { subtotal: Number(doc.subtotal || 0), total: Number(doc.total || 0), memo: doc.memo || null },
    lines: lines.map(makeLine)
  };
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
  return {
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
  };
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
  return {
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
  };
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
  return {
    organization,
    meta: makeMeta({ entityType: 'credit_note', documentNo: doc.credit_note_no || doc.note_no || doc.id, documentDate: doc.credit_note_date || doc.note_date, status: doc.status, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status, issuedAt: doc.issued_at }),
    counterparty: { name: doc.partner_name || null, email: doc.partner_email || null, phone: doc.partner_phone || null, address: addressFromRow('partner', doc) },
    summary: { subtotal: Number(doc.subtotal || 0), total: Number(doc.total || 0), memo: doc.memo || null },
    lines: lines.map(makeLine)
  };
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
  return {
    organization,
    meta: makeMeta({ entityType: 'debit_note', documentNo: doc.debit_note_no || doc.note_no || doc.id, documentDate: doc.debit_note_date || doc.note_date, status: doc.status, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status, issuedAt: doc.issued_at }),
    counterparty: { name: doc.partner_name || null, email: doc.partner_email || null, phone: doc.partner_phone || null, address: addressFromRow('partner', doc) },
    summary: { subtotal: Number(doc.subtotal || 0), total: Number(doc.total || 0), memo: doc.memo || null },
    lines: lines.map(makeLine)
  };
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
  return {
    organization,
    meta: makeMeta({ entityType, documentNo: doc.document_no, documentDate: doc.document_date, dueDate: doc.due_date, status: doc.status, reference: doc.reference, currencyCode: doc.currency_code, workflowStatus: doc.workflow_status }),
    counterparty: { name: counterpartyName, email: null, phone: null, address: null },
    summary: { subtotal: Number(doc.amount_total || 0), total: Number(doc.amount_total || 0), memo: doc.memo || null },
    lines: lines.map(makeLine)
  };
}

async function buildPayload({ orgId, entityType, documentId }) {
  switch (entityType) {
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
    organization: { name: 'Your Organization', base_currency_code: 'GHS', email: 'finance@example.com', phone: '+233000000000' },
    meta: { entityType, documentNo: 'DOC-000001', documentDate: '2026-03-20', dueDate: '2026-03-27', status: 'issued', reference: 'REF-001', currencyCode: 'GHS', workflowStatus: 'approved' },
    counterparty: { name: 'Sample Counterparty Ltd', email: 'accounts@example.com', phone: '+233000000111', address: { line1: '123 Sample Street', city: 'Accra', country: 'Ghana' } },
    summary: { subtotal: 1250.00, total: 1250.00, memo: 'Sample generated preview payload.', paymentMethodName: 'Bank Transfer', cashAccount: '1010 - Main Bank' },
    lines: [
      { lineNo: 1, description: 'Sample line 1', quantity: 2, unitPrice: 250, amount: 500 },
      { lineNo: 2, description: 'Sample line 2', quantity: 3, unitPrice: 250, amount: 750 }
    ]
  };
}

module.exports = { buildPayload, samplePayload };
