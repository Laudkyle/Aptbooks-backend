const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function groupTaxByCategory(lines = []) {
  const map = new Map();
  for (const line of lines) {
    const taxes = Array.isArray(line.taxes) ? line.taxes : [];
    for (const tax of taxes) {
      const key = `${tax.category_code || tax.categoryCode || 'S'}::${tax.tax_rate || tax.rate || 0}::${tax.tax_type || tax.taxType || 'VAT'}`;
      if (!map.has(key)) map.set(key, {
        categoryCode: tax.category_code || tax.categoryCode || 'S',
        taxType: tax.tax_type || tax.taxType || 'VAT',
        rate: Number(tax.tax_rate || tax.rate || 0),
        taxableAmount: 0,
        taxAmount: 0,
        exemptionReasonCode: tax.exemption_reason_code || tax.exemptionReasonCode || null
      });
      const bucket = map.get(key);
      bucket.taxableAmount += Number(tax.taxable_amount || tax.taxableAmount || 0);
      bucket.taxAmount += Number(tax.tax_amount || tax.taxAmount || 0);
    }
  }
  return Array.from(map.values()).map((b) => ({ ...b, taxableAmount: Number(b.taxableAmount.toFixed(2)), taxAmount: Number(b.taxAmount.toFixed(2)) }));
}

function buildInvoicePayload({ inv, org, customer, lines, taxTotals }) {
  return {
    profile: 'PEPPOL-BIS-3.0',
    customizationId: 'urn:cen.eu:en16931:2017',
    sourceType: 'invoice',
    invoiceNumber: inv.invoice_no || inv.id,
    issueDate: new Date(inv.invoice_date).toISOString().slice(0, 10),
    currencyCode: inv.currency_code || org.base_currency_code || 'GHS',
    supplier: {
      legalName: org.legal_name || org.name || 'Supplier',
      taxregistrationNumber: org.tax_registration_no || null,
      countryCode: org.country_code || 'GH'
    },
    customer: {
      name: customer.name || customer.legal_name || 'Customer',
      taxId: customer.tax_id || null,
      countryCode: customer.tax_country_code || null
    },
    monetaryTotal: {
      lineExtensionAmount: Number(inv.subtotal || 0),
      taxExclusiveAmount: Number(inv.subtotal || 0),
      taxInclusiveAmount: Number(inv.total || 0),
      payableAmount: Number(inv.total || 0)
    },
    taxTotals,
    lines: lines.map((l, idx) => ({
      id: idx + 1,
      description: l.description || 'Item',
      quantity: Number(l.quantity || 1),
      unitPrice: Number(l.unit_price || 0),
      lineExtensionAmount: Number(l.line_total || 0),
      taxableAmount: Number(l.taxable_amount || l.line_total || 0),
      taxAmount: Number(l.tax_amount || 0),
      taxes: Array.isArray(l.taxes) ? l.taxes.map((t) => ({
        taxType: t.tax_type || null,
        categoryCode: t.category_code || null,
        rate: Number(t.tax_rate || 0),
        taxableAmount: Number(t.taxable_amount || 0),
        taxAmount: Number(t.tax_amount || 0),
        exemptionReasonCode: t.exemption_reason_code || null,
        reverseCharge: t.reverse_charge === true
      })) : []
    }))
  };
}

function buildUblInvoiceXml({ inv, org, customer, lines, taxTotals }) {
  const issueDate = new Date(inv.invoice_date).toISOString().slice(0, 10);
  const currency = inv.currency_code || org.base_currency_code || "GHS";
  const taxTotalXml = taxTotals.map((t) => `
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${esc(currency)}">${esc(t.taxAmount.toFixed(2))}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${esc(currency)}">${esc(t.taxableAmount.toFixed(2))}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${esc(currency)}">${esc(t.taxAmount.toFixed(2))}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${esc(t.categoryCode)}</cbc:ID>
        <cbc:Percent>${esc((t.rate * 100).toFixed(2))}</cbc:Percent>
        ${t.exemptionReasonCode ? `<cbc:TaxExemptionReasonCode>${esc(t.exemptionReasonCode)}</cbc:TaxExemptionReasonCode>` : ''}
        <cac:TaxScheme><cbc:ID>${esc(t.taxType)}</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>`).join('\n');

  const lineXml = lines.map((l, idx) => {
    const qty = l.quantity ?? 1;
    const lineExt = Number(l.line_total || 0).toFixed(2);
    const unitPrice = Number(l.unit_price || 0).toFixed(2);
    const taxes = Array.isArray(l.taxes) ? l.taxes : [];
    const firstTax = taxes[0] || {};
    return `
    <cac:InvoiceLine>
      <cbc:ID>${esc(idx + 1)}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="EA">${esc(qty)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${esc(currency)}">${esc(lineExt)}</cbc:LineExtensionAmount>
      <cac:TaxTotal><cbc:TaxAmount currencyID="${esc(currency)}">${esc(Number(l.tax_amount || 0).toFixed(2))}</cbc:TaxAmount></cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${esc(l.description || "Item")}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${esc(firstTax.category_code || 'S')}</cbc:ID>
          <cbc:Percent>${esc((Number(firstTax.tax_rate || 0) * 100).toFixed(2))}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>${esc(firstTax.tax_type || 'VAT')}</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price><cbc:PriceAmount currencyID="${esc(currency)}">${esc(unitPrice)}</cbc:PriceAmount></cac:Price>
    </cac:InvoiceLine>`;
  }).join("\n");

  const payable = Number(inv.total || 0).toFixed(2);
  const taxExclusive = Number(inv.subtotal || 0).toFixed(2);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${esc(inv.invoice_no || inv.id)}</cbc:ID>
  <cbc:IssueDate>${esc(issueDate)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${esc(currency)}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>${esc(org.legal_name || org.name || 'Supplier')}</cbc:Name></cac:PartyName><cac:PartyTaxScheme><cbc:CompanyID>${esc(org.tax_registration_no || '')}</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>${esc(customer.name || customer.legal_name || 'Customer')}</cbc:Name></cac:PartyName><cac:PartyTaxScheme><cbc:CompanyID>${esc(customer.tax_id || '')}</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingCustomerParty>
  ${taxTotalXml}
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="${esc(currency)}">${esc(taxExclusive)}</cbc:TaxExclusiveAmount>
    <cbc:PayableAmount currencyID="${esc(currency)}">${esc(payable)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${lineXml}
</Invoice>`;
}

async function loadInvoiceContext({ orgId, invoiceId }) {
  const { rows: invRows } = await pool.query(`SELECT * FROM invoices WHERE organization_id=$1 AND id=$2`, [orgId, invoiceId]);
  const inv = invRows[0];
  if (!inv) throw new AppError(404, 'Invoice not found');
  if (inv.status !== 'issued' && inv.status !== 'paid') throw new AppError(409, 'Only issued/paid invoices can be e-invoiced');

  const { rows: orgRows } = await pool.query(`SELECT * FROM organizations WHERE id=$1`, [orgId]);
  const org = orgRows[0] || {};
  const { rows: custRows } = await pool.query(`SELECT id, name, tax_id, tax_country_code FROM business_partners WHERE organization_id=$1 AND id=$2`, [orgId, inv.customer_id]);
  const customer = custRows[0] || { name: 'Customer' };
  const { rows: lineRows } = await pool.query(`SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id ASC`, [invoiceId]);
  const lineIds = lineRows.map((r) => r.id);
  const taxes = lineIds.length ? await pool.query(`SELECT * FROM invoice_line_tax_details WHERE line_id = ANY($1::uuid[]) ORDER BY line_id, sequence_no`, [lineIds]) : { rows: [] };
  const byLine = new Map();
  for (const tax of taxes.rows) {
    if (!byLine.has(tax.line_id)) byLine.set(tax.line_id, []);
    byLine.get(tax.line_id).push(tax);
  }
  const lines = lineRows.map((l) => ({ ...l, taxes: byLine.get(l.id) || [] }));
  const taxTotals = groupTaxByCategory(lines);
  return { inv, org, customer, lines, taxTotals };
}

async function generateInvoiceEInvoice({ orgId, actorUserId, invoiceId }) {
  const ctx = await loadInvoiceContext({ orgId, invoiceId });
  const payload = buildInvoicePayload(ctx);
  const xml = buildUblInvoiceXml(ctx);

  const { rows: existing } = await pool.query(`SELECT id FROM e_invoices WHERE organization_id=$1 AND source_type='invoice' AND source_id=$2`, [orgId, invoiceId]);
  if (existing.length) {
    const { rows } = await pool.query(
      `UPDATE e_invoices SET ubl_xml=$3, payload_json=$4::jsonb, profile_code='PEPPOL-BIS-3.0', status='generated', created_by=COALESCE($5, created_by), updated_at=NOW() WHERE organization_id=$1 AND source_type='invoice' AND source_id=$2 RETURNING *`,
      [orgId, invoiceId, xml, JSON.stringify(payload), actorUserId || null]
    );
    return rows[0];
  }

  const { rows } = await pool.query(
    `INSERT INTO e_invoices(organization_id, source_type, source_id, ubl_xml, payload_json, profile_code, status, network, created_by)
     VALUES($1,'invoice',$2,$3,$4::jsonb,'PEPPOL-BIS-3.0','generated','none',$5)
     RETURNING *`,
    [orgId, invoiceId, xml, JSON.stringify(payload), actorUserId || null]
  );
  return rows[0];
}

async function queueTransmission({ orgId, actorUserId, eInvoiceId, adapterCode = 'PEPPOL_SIM' }) {
  const { rows: invRows } = await pool.query(`SELECT * FROM e_invoices WHERE organization_id=$1 AND id=$2`, [orgId, eInvoiceId]);
  const eInvoice = invRows[0];
  if (!eInvoice) throw new AppError(404, 'E-invoice not found');

  const requestPayload = {
    profileCode: eInvoice.profile_code || 'PEPPOL-BIS-3.0',
    sourceType: eInvoice.source_type,
    sourceId: eInvoice.source_id,
    network: adapterCode,
    payload: eInvoice.payload_json || {}
  };

  const { rows } = await pool.query(
    `INSERT INTO e_invoice_transmissions(organization_id, e_invoice_id, adapter_code, status, request_payload, transmitted_at)
     VALUES($1,$2,$3,'queued',$4::jsonb,NOW()) RETURNING *`,
    [orgId, eInvoiceId, adapterCode, JSON.stringify(requestPayload)]
  );
  await pool.query(`UPDATE e_invoices SET status='queued', network_reference=$3, last_transmitted_at=NOW(), updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, eInvoiceId, adapterCode]);
  return rows[0];
}

async function listTransmissions({ orgId, eInvoiceId }) {
  const params = [orgId];
  let sql = `SELECT * FROM e_invoice_transmissions WHERE organization_id=$1`;
  if (eInvoiceId) {
    params.push(eInvoiceId);
    sql += ` AND e_invoice_id=$2`;
  }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getEInvoice({ orgId, id }) {
  const { rows } = await pool.query(`SELECT * FROM e_invoices WHERE organization_id=$1 AND id=$2`, [orgId, id]);
  return rows[0] || null;
}

async function getEInvoiceBySource({ orgId, sourceType, sourceId }) {
  const { rows } = await pool.query(
    `SELECT * FROM e_invoices WHERE organization_id=$1 AND source_type=$2 AND source_id=$3`,
    [orgId, sourceType, sourceId]
  );
  return rows[0] || null;
}

async function getInvoiceEInvoicePreview({ orgId, invoiceId }) {
  const ctx = await loadInvoiceContext({ orgId, invoiceId });
  const payload = buildInvoicePayload(ctx);
  const xml = buildUblInvoiceXml(ctx);
  const existing = await getEInvoiceBySource({ orgId, sourceType: 'invoice', sourceId: invoiceId });
  return {
    source_type: 'invoice',
    source_id: invoiceId,
    has_generated_record: !!existing,
    existing_einvoice_id: existing?.id || null,
    status: existing?.status || 'preview',
    profile_code: existing?.profile_code || 'PEPPOL-BIS-3.0',
    network: existing?.network || 'none',
    payload,
    ubl_xml: xml,
    generated_at: new Date().toISOString()
  };
}

async function getInvoiceFilingStatus({ orgId, invoiceId }) {
  const invoiceCtx = await loadInvoiceContext({ orgId, invoiceId });
  const existing = await getEInvoiceBySource({ orgId, sourceType: 'invoice', sourceId: invoiceId });

  if (!existing) {
    return {
      source_type: 'invoice',
      source_id: invoiceId,
      invoice_status: invoiceCtx.inv.status,
      filing_status: 'not_generated',
      can_generate: invoiceCtx.inv.status === 'issued' || invoiceCtx.inv.status === 'paid',
      e_invoice: null,
      latest_transmission: null,
      transmission_count: 0
    };
  }

  const { rows } = await pool.query(
    `SELECT * FROM e_invoice_transmissions WHERE organization_id=$1 AND e_invoice_id=$2 ORDER BY created_at DESC`,
    [orgId, existing.id]
  );
  const latest = rows[0] || null;

  return {
    source_type: 'invoice',
    source_id: invoiceId,
    invoice_status: invoiceCtx.inv.status,
    filing_status: existing.status || 'generated',
    can_generate: false,
    e_invoice: existing,
    latest_transmission: latest,
    transmission_count: rows.length
  };
}

module.exports = { generateInvoiceEInvoice, getEInvoice, queueTransmission, listTransmissions, getEInvoiceBySource, getInvoiceEInvoicePreview, getInvoiceFilingStatus };
