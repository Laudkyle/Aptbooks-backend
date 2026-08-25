const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('AR/AP settlement services use exact-money primitives instead of float tolerances', () => {
  for (const rel of [
    'modules/transactions/receipts/customer-receipts/customerReceipts.service.js',
    'modules/transactions/payments/vendor-payments/vendorPayments.service.js',
  ]) {
    const src = read(rel);
    assert.match(src, /applyFractionToMoneyUnits/);
    assert.match(src, /moneyUnits/);
    assert.doesNotMatch(src, /1e-9/);
  }
});

test('invoice and bill issuance build posting balances in exact minor units', () => {
  const invoice = read('modules/transactions/invoices/invoices.service.js');
  const bill = read('modules/transactions/bills/bills.service.js');
  assert.match(invoice, /computedReceivableUnits/);
  assert.match(invoice, /outstandingUnits \+ invoiceUnits > limitUnits/);
  assert.doesNotMatch(invoice, /\.toFixed\(2\)/);
  assert.match(bill, /computedPayableUnits/);
  assert.doesNotMatch(bill, /\.toFixed\(2\)/);
});

test('operational document posting does not aggregate monetary values with Number', () => {
  const src = read('modules/transactions/_shared/operationalDocPosting.service.js');
  assert.match(src, /moneyStringFromUnits/);
  assert.match(src, /totalTaxUnits/);
  assert.doesNotMatch(src, /function round2/);
  assert.doesNotMatch(src, /Number\(line\.line_total/);
});

test('inventory costing uses six-decimal fixed-point quantities and costs with explicit journal rounding', () => {
  const svc = read('modules/inventory/transactions/transactions.service.js');
  const repo = read('modules/inventory/transactions/transactions.repository.js');
  assert.match(svc, /weightedAverageUnitCost/);
  assert.match(svc, /multiplyQuantityByUnitCost/);
  assert.match(svc, /inventoryValueToJournalMoney/);
  assert.doesNotMatch(svc, /function round6/);
  assert.match(repo, /quantityUnits/);
  assert.doesNotMatch(repo, /Math\.min\(remaining/);
});

test('asset valuation and depreciation use exact money with deterministic final-period catch-up', () => {
  const assets = read('modules/assets/fixed-assets/fixedAssets.service.js');
  const depreciation = read('modules/assets/depreciation/depreciation.service.js');
  const depreciationRepo = read('modules/assets/depreciation/depreciation.repository.js');
  const migration = read('db/migrations/sql/155_step3_financial_precision_hardening.sql');
  assert.match(assets, /moneyUnits/);
  assert.match(assets, /loadAssetBookState/);
  assert.match(assets, /grossBookUnits = book\.grossBookUnits/);
  assert.match(assets, /(?:baseValueUnits|carryingUnits) = book\.carryingUnits/);
  assert.doesNotMatch(assets, /asset\.current_value != null/);
  assert.doesNotMatch(assets, /\.toFixed\(2\)/);
  assert.match(depreciation, /periodicDepreciationUnits/);
  assert.match(depreciation, /COALESCE\(SUM\(basis_amount\),0\)::numeric AS amount/);
  assert.match(depreciation, /alreadyAllocated \+ basisUnits > book\.grossBookUnits/);
  assert.match(depreciation, /entryType: 'reversal'/);
  assert.match(depreciationRepo, /entryType === 'reversal'.*`-\$\{posting\.amount\}`/s);
  for (const method of ['hasPostings', 'getRunByPeriod', 'createOrRestartRun', 'markRun', 'linkRunPosting', 'insertDepreciationTransactions']) {
    assert.match(depreciationRepo, new RegExp(`async function ${method}`));
  }
  assert.match(migration, /entry_type='depreciation' AND amount > 0/);
  assert.match(migration, /entry_type='reversal' AND amount < 0/);
  assert.match(migration, /organization_id, schedule_id, period_id, entry_type/);
});

test('AR/AP statement identity lookups are tenant scoped', () => {
  const ar = read('reporting/ar/ar.service.js');
  const ap = read('reporting/ap/ap.service.js');
  assert.match(ar, /business_partners\s+WHERE organization_id=\$1 AND id=\$2/);
  assert.match(ap, /business_partners\s+WHERE organization_id=\$1 AND id=\$2/);
  assert.match(ar, /runningCents/);
  assert.match(ap, /runningCents/);
});

test('ledger reconciliation technical equality is exact rather than tolerance based', () => {
  const src = read('core/accounting/ledger/reconciliation.service.js');
  assert.match(src, /technicalMatch = diffDebitCents === 0n && diffCreditCents === 0n/);
  assert.match(src, /exactMatchTolerance: 0/);
  assert.doesNotMatch(src, /exactMatchTolerance:\s*0\.005/);
});

test('IFRS16 monetary persistence keeps Decimal text instead of converting to binary Number', () => {
  const measurement = read('compliance/ifrs16/services/measurement.js');
  const measurementService = read('compliance/ifrs16/services/measurement.service.js');
  const workflow = read('compliance/ifrs16/services/workflow.service.js');
  const core = read('compliance/ifrs16/services/core.service.js');
  assert.doesNotMatch(measurement, /\.toNumber\(\)/);
  assert.doesNotMatch(measurementService, /\.toNumber\(\)/);
  assert.doesNotMatch(workflow, /\.toNumber\(\)/);
  assert.match(core, /amount\.toFixed\(6\)/);
});

test('IFRS9 calculated ECL persistence no longer calls Decimal.toNumber and movement aggregation uses Decimal', () => {
  const src = read('compliance/ifrs9/ifrs9.service.js');
  assert.doesNotMatch(src, /\.toNumber\(\)/);
  assert.match(src, /additionsDecimal/);
  assert.match(src, /openingAllowanceDecimal/);
  assert.match(src, /new Decimal\(outstanding \|\| 0\)\.lte\(0\)/);
});
