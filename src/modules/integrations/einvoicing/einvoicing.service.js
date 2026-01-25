const { pool } = require("../../../db/pool"); 
const { AppError } = require("../../../shared/errors/AppError"); 

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp; ").replace(/</g, "&lt; ").replace(/>/g, "&gt; ").replace(/"/g, "&quot; ").replace(/'/g, "&apos; "); 
}

function buildUblInvoiceXml({ inv, org, supplier, customer, lines }) {
  // Minimal UBL 2.1 Invoice. This is intentionally minimal and should be extended for production tax/jurisdiction requirements.
  const issueDate = new Date(inv.invoice_date).toISOString().slice(0, 10); 
  const currency = inv.currency_code || org.base_currency_code || "GHS"; 
  const lineXml = lines.map((l, idx) => {
    const qty = l.quantity ?? 1; 
    const lineExt = Number(l.line_total || l.line_total_amount || 0).toFixed(2); 
    const unitPrice = Number(l.unit_price || 0).toFixed(2); 
    return `
    <cac:InvoiceLine>
      <cbc:ID>${esc(idx + 1)}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="EA">${esc(qty)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${esc(currency)}">${esc(lineExt)}</cbc:LineExtensionAmount>
      <cac:Item><cbc:Name>${esc(l.description || l.item_name || "Item")}</cbc:Name></cac:Item>
      <cac:Price><cbc:PriceAmount currencyID="${esc(currency)}">${esc(unitPrice)}</cbc:PriceAmount></cac:Price>
    </cac:InvoiceLine>`; 
  }).join("\n"); 

  const payable = Number(inv.total_amount || inv.total || inv.grand_total || 0).toFixed(2); 

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ID>${esc(inv.invoice_no || inv.id)}</cbc:ID>
  <cbc:IssueDate>${esc(issueDate)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${esc(currency)}</cbc:DocumentCurrencyCode>

  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${esc(org.legal_name || org.name || "Supplier")}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(org.address_line1 || "")}</cbc:StreetName>
        <cbc:CityName>${esc(org.city || "")}</cbc:CityName>
        <cbc:CountrySubentity>${esc(org.state_province || "")}</cbc:CountrySubentity>
        <cac:Country><cbc:IdentificationCode>${esc(org.country_code || "GH")}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme><cbc:CompanyID>${esc(org.tax_registration_no || "")}</cbc:CompanyID></cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>

  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${esc(customer.name || customer.legal_name || "Customer")}</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme><cbc:CompanyID>${esc(customer.tax_id || "")}</cbc:CompanyID></cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingCustomerParty>

  <cac:LegalMonetaryTotal>
    <cbc:PayableAmount currencyID="${esc(currency)}">${esc(payable)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>

  ${lineXml}
</Invoice>`; 
}

async function generateInvoiceEInvoice({ orgId, actorUserId, invoiceId }) {
  const { rows: invRows } = await pool.query(
    `SELECT * FROM invoices WHERE organization_id=$1 AND id=$2`,
    [orgId, invoiceId]
  ); 
  const inv = invRows[0]; 
  if (!inv) throw new AppError(404, "Invoice not found"); 
  if (inv.status !== "issued" && inv.status !== "paid") throw new AppError(409, "Only issued/paid invoices can be e-invoiced"); 

  const { rows: orgRows } = await pool.query(`SELECT * FROM organizations WHERE id=$1`, [orgId]); 
  const org = orgRows[0] || {}; 

  const { rows: custRows } = await pool.query(
    `SELECT id, name, tax_id FROM business_partners WHERE organization_id=$1 AND id=$2`,
    [orgId, inv.customer_id]
  ); 
  const customer = custRows[0] || { name: "Customer" }; 

  const { rows: lineRows } = await pool.query(
    `SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id ASC`,
    [invoiceId]
  ); 

  const xml = buildUblInvoiceXml({ inv, org, supplier: org, customer, lines: lineRows }); 

  const { rows: existing } = await pool.query(
    `SELECT id FROM e_invoices WHERE organization_id=$1 AND source_type='invoice' AND source_id=$2`,
    [orgId, invoiceId]
  ); 
  if (existing.length) {
    const { rows } = await pool.query(
      `UPDATE e_invoices SET ubl_xml=$3, status='generated', created_by=COALESCE($4, created_by) WHERE organization_id=$1 AND source_type='invoice' AND source_id=$2 RETURNING *`,
      [orgId, invoiceId, xml, actorUserId || null]
    ); 
    return rows[0]; 
  }

  const { rows } = await pool.query(
    `INSERT INTO e_invoices(organization_id, source_type, source_id, ubl_xml, status, network, created_by)
     VALUES($1,'invoice',$2,$3,'generated','none',$4)
     RETURNING *`,
    [orgId, invoiceId, xml, actorUserId || null]
  ); 
  return rows[0]; 
}

async function getEInvoice({ orgId, id }) {
  const { rows } = await pool.query(`SELECT * FROM e_invoices WHERE organization_id=$1 AND id=$2`, [orgId, id]); 
  return rows[0] || null; 
}

module.exports = { generateInvoiceEInvoice, getEInvoice }; 
