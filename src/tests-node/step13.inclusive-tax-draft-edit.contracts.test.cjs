const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { computeComponentTaxBreakdown } = require('../shared/tax/taxMath');

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('inclusive Ghana compound tax extracts one shared base instead of adding tax on top', () => {
  const result = computeComponentTaxBreakdown({
    amount: '120.00',
    inclusive: true,
    components: [{ rate: '15' }, { rate: '2.5' }, { rate: '2.5' }],
  });
  assert.equal(result.taxableAmount, '100.00');
  assert.equal(result.taxAmount, '20.00');
  assert.equal(result.totalAmount, '120.00');
  assert.deepEqual(result.components.map((c) => c.taxAmount), ['15.00', '2.50', '2.50']);
});

test('shared tax engine honors document pricing mode and uses common-base compound inclusive calculation', () => {
  const multiTax = read('src/shared/tax/multiTax.js');
  const invoices = read('src/modules/transactions/invoices/invoices.service.js');
  const bills = read('src/modules/transactions/bills/bills.service.js');
  assert.match(multiTax, /documentPricingMode/);
  assert.match(multiTax, /documentPricingMode === 'inclusive'/);
  assert.match(multiTax, /computeComponentTaxBreakdown\(\{/);
  assert.match(multiTax, /allPriceComponentsInclusive/);
  assert.match(invoices, /pricingMode:\s*payload\.pricingMode/);
  assert.match(bills, /pricingMode:\s*payload\.pricingMode/);
});

test('detail enrichment treats entered line total as inclusive gross and only adds exclusive tax', () => {
  const src = read('src/modules/transactions/_shared/detailEnrichment.js');
  assert.match(src, /enteredLineTotal\s*=\s*Number\(line\.line_total/);
  assert.match(src, /taxableAmount\s*=\s*Math\.max\(0, enteredLineTotal - inclusiveTaxAmount\)/);
  assert.match(src, /grossAmount\s*=\s*round2\(enteredLineTotal \+ exclusiveTaxAmount\)/);
  assert.match(src, /lineGrossTotal/);
});

test('all core transaction drafts expose draft-only update commands', () => {
  const pairs = [
    ['src/modules/transactions/invoices/invoices.routes.js', 'src/modules/transactions/invoices/invoices.service.js', 'updateDraftInvoice', /Only draft invoices can be edited/],
    ['src/modules/transactions/bills/bills.routes.js', 'src/modules/transactions/bills/bills.service.js', 'updateDraftBill', /Only draft bills can be edited/],
    ['src/modules/transactions/receipts/customer-receipts/customerReceipts.routes.js', 'src/modules/transactions/receipts/customer-receipts/customerReceipts.service.js', 'updateDraftCustomerReceipt', /Only draft customer receipts can be edited/],
    ['src/modules/transactions/payments/vendor-payments/vendorPayments.routes.js', 'src/modules/transactions/payments/vendor-payments/vendorPayments.service.js', 'updateDraftVendorPayment', /Only draft vendor payments can be edited/],
    ['src/modules/transactions/credit-notes/creditNotes.routes.js', 'src/modules/transactions/credit-notes/creditNotes.service.js', 'updateDraftCreditNote', /Only draft credit notes can be edited/],
    ['src/modules/transactions/debit-notes/debitNotes.routes.js', 'src/modules/transactions/debit-notes/debitNotes.service.js', 'updateDraftDebitNote', /Only draft debit notes can be edited/],
  ];
  for (const [routeFile, serviceFile, fn, guard] of pairs) {
    const routes = read(routeFile);
    const service = read(serviceFile);
    assert.match(routes, /router\.put\("\/:id"/);
    assert.match(routes, new RegExp(fn));
    assert.match(service, new RegExp(`async function ${fn}`));
    assert.match(service, guard);
  }
  const opsRoutes = read('src/modules/transactions/_shared/opsDocs.routes.js');
  const opsService = read('src/modules/transactions/_shared/opsDocs.service.js');
  assert.match(opsRoutes, /router\.put\("\/:id"/);
  assert.match(opsService, /async function updateDraft/);
  assert.match(opsService, /Only draft \$\{moduleCode\} documents can be edited/);
});
