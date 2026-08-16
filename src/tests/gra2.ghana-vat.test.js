const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  computeTurnoverRecoveryRatio,
  calculateInputTaxApportionment,
  calculateVatRegistrationMonitor,
} = require('../shared/tax/ghanaVat');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('Act 1151 apportionment: below 5% gives no mixed-input recovery', () => {
  const out = computeTurnoverRecoveryRatio({ taxableSupplies: '4.99', totalSupplies: '100.00' });
  assert.equal(out.allowedRatio, '0.000000');
  assert.equal(out.thresholdApplied, 'below_5_percent_none');
});

test('Act 1151 apportionment: exactly 5% remains pro-rata', () => {
  const out = computeTurnoverRecoveryRatio({ taxableSupplies: '5.00', totalSupplies: '100.00' });
  assert.equal(out.allowedRatio, '0.050000');
  assert.equal(out.thresholdApplied, 'pro_rata');
});

test('Act 1151 apportionment: exactly 95% remains pro-rata', () => {
  const out = computeTurnoverRecoveryRatio({ taxableSupplies: '95.00', totalSupplies: '100.00' });
  assert.equal(out.allowedRatio, '0.950000');
  assert.equal(out.thresholdApplied, 'pro_rata');
});

test('Act 1151 apportionment: above 95% gives full mixed-input recovery', () => {
  const out = computeTurnoverRecoveryRatio({ taxableSupplies: '95.01', totalSupplies: '100.00' });
  assert.equal(out.allowedRatio, '1.000000');
  assert.equal(out.thresholdApplied, 'above_95_percent_full');
});

test('mixed input uses A x B / C and keeps direct attribution separate', () => {
  const out = calculateInputTaxApportionment({
    taxableSupplies: '60000.00',
    exemptSupplies: '40000.00',
    mixedInputTax: '1000.00',
    directTaxableInputTax: '250.00',
    directExemptInputTax: '100.00',
  });
  assert.equal(out.allowedRecoveryRatio, '0.600000');
  assert.equal(out.recoverableMixedInputTax, '600.00');
  assert.equal(out.nonRecoverableMixedInputTax, '400.00');
  assert.equal(out.totalRecoverableInputTax, '850.00');
  assert.equal(out.totalNonRecoverableInputTax, '500.00');
});

test('VAT registration monitor flags the GH¢750,000 goods threshold', () => {
  assert.equal(calculateVatRegistrationMonitor({ taxableGoodsTurnover: '740000', threshold: '750000' }).status, 'approaching_threshold');
  const at = calculateVatRegistrationMonitor({ taxableGoodsTurnover: '750000', threshold: '750000' });
  assert.equal(at.status, 'threshold_met');
  assert.equal(at.registrationRequiredByMonitor, true);
  assert.equal(calculateVatRegistrationMonitor({ taxableGoodsTurnover: '760000', threshold: '750000', isRegistered: true }).status, 'registered');
});

test('GRA-2 migration adds recovery, apportionment, threshold and imported-service structures', () => {
  const sql = read('db/migrations/sql/149_gra2_ghana_vat_compliance.sql');
  for (const token of [
    'mixed_input_provisional_percent',
    'gh_vat_goods_registration_threshold',
    'tax_vat_registration_monitor_snapshots',
    'purchase_recovery_mode',
    'tax_input_apportionment_periods',
    'imported_service_transactions',
    'imported_service_tax_details',
    'GH_IMPORTED_SERVICES_20',
    'GH_MIXED_INPUT',
  ]) assert.match(sql, new RegExp(token));
});

test('tax ledger supports recoverability for reverse-charge imported services', () => {
  const src = read('shared/tax/taxLedger.js');
  assert.match(src, /direction === 'input' \|\| direction === 'reverse_charge'/);
  assert.match(src, /syncImportedServiceTaxDetailToLedger/);
  assert.match(src, /recovery_basis/);
});

test('GRA-2 service implements threshold, apportionment and imported-services posting', () => {
  const src = read('core/accounting/tax/ghanaVat.service.js');
  assert.match(src, /getVatRegistrationMonitor/);
  assert.match(src, /calculateInputApportionment/);
  assert.match(src, /postInputApportionment/);
  assert.match(src, /createImportedService/);
  assert.match(src, /postImportedService/);
  assert.match(src, /GH_IMPORTED_SERVICES_20/);
});

test('VAT reports use recoverable input and include imported-service reverse charge', () => {
  const src = read('reporting/tax/tax.service.js');
  assert.match(src, /source_type='imported_service'/);
  assert.match(src, /signed_recoverable_amount/);
  assert.match(src, /direction === 'input' \|\| r\.direction === 'reverse_charge'/);
  assert.match(src, /imported_services_output_tax/);
});

test('catalog and tax settings APIs expose GRA-2 recovery/monitor configuration', () => {
  const validator = read('core/accounting/tax/tax.validators.js');
  const service = read('core/accounting/tax/tax.service.js');
  for (const token of ['purchaseRecoveryMode','defaultRecoverablePercent','legalReference','mixedInputProvisionalPercent','ghVatGoodsRegistrationThreshold']) {
    assert.match(validator, new RegExp(token));
  }
  assert.match(service, /purchase_recovery_mode/);
  assert.match(service, /gh_vat_goods_registration_threshold/);
});


test('Ghana VAT return de-duplicates taxable base across VAT/NHIL/GETFund components', () => {
  const src = read('reporting/tax/tax.service.js');
  assert.match(src, /function uniqueSignedTaxableTotal/);
  assert.match(src, /const taxableTotal = uniqueSignedTaxableTotal\(rows\)/);
});

test('Ghana reconciliation includes VAT, NHIL and GETFund rather than VAT-only rows', () => {
  const src = read('reporting/tax/tax.service.js');
  assert.match(src, /includeGhanaComponents = false/);
  assert.match(src, /effectiveTaxType = includeGhanaComponents \? 'GHANA_VAT'/);
  assert.match(src, /taxReconciliation\(\{ orgId, fromDate, toDate, taxType: null, includeGhanaComponents: true \}\)/);
});

test('posting and voiding mixed-input apportionment updates and restores tax-ledger recovery', () => {
  const src = read('core/accounting/tax/ghanaVat.service.js');
  assert.match(src, /apportionment_period_id=\$5/);
  assert.match(src, /preApportionmentRecoverableAmount/);
  assert.match(src, /voidInputApportionment/);
});

test('imported services are due 21 days after the tax period and post as reverse charge', () => {
  const migration = read('db/migrations/sql/149_gra2_ghana_vat_compliance.sql');
  const service = read('core/accounting/tax/ghanaVat.service.js');
  assert.match(service, /declaration_due_date/);
  assert.match(service, /\(\$6::date\+21\)/);
  assert.match(service, /'reverse_charge'/);
  assert.match(migration, /GH_IMPORTED_SERVICES_20/);
});

test('future input tax adjustments carry explicit recoverability classification', () => {
  const src = read('shared/tax/taxLedger.js');
  assert.match(src, /adjustment\.direction === 'input' \? 'direct_taxable' : 'not_applicable'/);
  assert.match(src, /recovery_basis=EXCLUDED\.recovery_basis/);
});
