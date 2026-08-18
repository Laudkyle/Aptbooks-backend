const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('compound tax details persist actual tax_code ids, not tax_code_components relationship ids', () => {
  const src = read('shared/tax/multiTax.js');
  assert.match(src, /taxCodeId:\s*taxCode\.tax_code_id\s*\|\|\s*taxCode\.id/);
  assert.match(src, /JOIN tax_codes tc ON tc\.id = tcc\.component_tax_code_id AND tc\.organization_id=tcc\.organization_id/);
  assert.doesNotMatch(src, /taxCodeId:\s*taxCode\.id\s*\|\|\s*taxCode\.tax_code_id/);
});

test('invoice and bill tax preview endpoints exist server-side', () => {
  const invoiceRoutes = read('modules/transactions/invoices/invoices.routes.js');
  const billRoutes = read('modules/transactions/bills/bills.routes.js');
  const invoiceService = read('modules/transactions/invoices/invoices.service.js');
  const billService = read('modules/transactions/bills/bills.service.js');

  assert.match(invoiceRoutes, /router\.post\("\/preview\/determine-taxes"/);
  assert.match(invoiceRoutes, /svc\.previewInvoiceTaxes/);
  assert.match(invoiceService, /async function previewInvoiceTaxes/);

  assert.match(billRoutes, /router\.post\("\/preview\/determine-taxes"/);
  assert.match(billRoutes, /svc\.previewBillTaxes/);
  assert.match(billService, /async function previewBillTaxes/);
});

test('compound Ghana-style bundle resolves component tax IDs and amounts without FK-invalid relationship IDs', async () => {
  const { resolveLineTaxes } = require('../shared/tax/multiTax');
  const parentId = 'parent-tax-code';
  const vatId = 'vat-tax-code';
  const nhilId = 'nhil-tax-code';
  const getfundId = 'getfund-tax-code';

  const client = {
    async query(sql) {
      if (sql.includes('FROM tax_settings')) return { rows: [{}] };
      if (sql.includes('FROM tax_codes') && sql.includes('WHERE organization_id=$1 AND id=$2') && !sql.includes('tax_code_components')) {
        return { rows: [{
          id: parentId, organization_id: 'org', code: 'GH_STD', name: 'Ghana Standard',
          tax_type: 'VAT', rate: '0', is_compound: true, direction: 'output', box_code: null,
          status: 'active', category_code: null, tax_scope: 'taxable', application_scope: 'sales',
          calculation_method: 'standard', exemption_reason_code: null, exemption_reason: null,
          reverse_charge: false, recoverable_percent: '1', reporting_group: 'VAT', posting_account_id: null,
          metadata: {}
        }] };
      }
      if (sql.includes('FROM tax_code_components')) {
        const component = (relationshipId, taxCodeId, code, rate, type) => ({
          id: relationshipId,
          parent_tax_code_id: parentId,
          component_tax_code_id: taxCodeId,
          sequence_no: 1,
          rate_override: null,
          tax_code_id: taxCodeId,
          code,
          name: code,
          tax_type: type,
          rate,
          direction: 'output',
          box_code: null,
          status: 'active',
          category_code: null,
          tax_scope: 'taxable',
          application_scope: 'sales',
          calculation_method: 'standard',
          exemption_reason_code: null,
          exemption_reason: null,
          reverse_charge: false,
          recoverable_percent: '1',
          reporting_group: type,
          posting_account_id: null,
          metadata: {}
        });
        return { rows: [
          component('relationship-vat', vatId, 'VAT15', '15', 'VAT'),
          component('relationship-nhil', nhilId, 'NHIL25', '2.5', 'LEVY'),
          component('relationship-getfund', getfundId, 'GETFUND25', '2.5', 'LEVY'),
        ] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    }
  };

  const out = await resolveLineTaxes({
    client,
    orgId: 'org',
    line: { taxCodeId: parentId },
    defaultTaxableAmount: '50000.00',
    context: { transactionScope: 'sales', documentType: 'invoice' }
  });

  assert.deepEqual(out.components.map((c) => c.taxCodeId), [vatId, nhilId, getfundId]);
  assert.deepEqual(out.components.map((c) => c.taxAmount), ['7500.00', '1250.00', '1250.00']);
  assert.equal(out.taxAmount, '10000.00');
});
