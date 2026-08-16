const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  calculateIncomeWithholding,
  calculateVatWithholding,
  withholdingDueDate,
  percentageOf,
} = require('../shared/tax/ghanaWithholding');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('Ghana income WHT uses percentage-point rates', () => {
  assert.equal(percentageOf('1000.00', '3.000000'), '30.00');
  assert.equal(percentageOf('1000.00', '7.500000'), '75.00');
});

test('annual cumulative threshold does not withhold below GH¢2,000', () => {
  const out = calculateIncomeWithholding({ paymentAmount:'900.00', rate:'3', priorQualifyingPayments:'1000.00', thresholdAmount:'2000.00', thresholdBasis:'annual_cumulative' });
  assert.equal(out.applies, false);
  assert.equal(out.cumulativeQualifyingPayments, '1900.00');
  assert.equal(out.withheldAmount, '0.00');
});

test('annual cumulative threshold at exactly GH¢2,000 still has no withholding event amount', () => {
  const out = calculateIncomeWithholding({ paymentAmount:'1000.00', rate:'3', priorQualifyingPayments:'1000.00', thresholdAmount:'2000.00', thresholdBasis:'annual_cumulative' });
  assert.equal(out.applies, false);
  assert.equal(out.thresholdStatus, 'at_threshold');
});

test('crossing the annual threshold applies WHT to the current qualifying payment', () => {
  const out = calculateIncomeWithholding({ paymentAmount:'500.00', rate:'3', priorQualifyingPayments:'1800.00', thresholdAmount:'2000.00', thresholdBasis:'annual_cumulative' });
  assert.equal(out.applies, true);
  assert.equal(out.thresholdStatus, 'crossed_threshold');
  assert.equal(out.withheldAmount, '15.00');
});

test('subsequent payment after annual threshold remains subject to WHT', () => {
  const out = calculateIncomeWithholding({ paymentAmount:'1000.00', rate:'7.5', priorQualifyingPayments:'3000.00', thresholdAmount:'2000.00', thresholdBasis:'annual_cumulative' });
  assert.equal(out.applies, true);
  assert.equal(out.thresholdStatus, 'already_exceeded');
  assert.equal(out.withheldAmount, '75.00');
});

test('withholding exemption suppresses income WHT', () => {
  const out = calculateIncomeWithholding({ paymentAmount:'10000.00', rate:'7.5', thresholdBasis:'none', exempt:true });
  assert.equal(out.applies, false);
  assert.equal(out.withheldAmount, '0.00');
});

test('VAT withholding is 7% of standard-rated taxable value for an appointed agent', () => {
  const out = calculateVatWithholding({ taxableValue:'1000.00', rate:'7', isWithholdingAgent:true, supplierVatRegistered:true, standardRatedSupply:true });
  assert.equal(out.applies, true);
  assert.equal(out.withheldAmount, '70.00');
});

test('VAT withholding does not apply to exempt/non-standard supplies', () => {
  assert.equal(calculateVatWithholding({ taxableValue:'1000', isWithholdingAgent:true, supplierVatRegistered:true, standardRatedSupply:false }).withheldAmount, '0.00');
  assert.equal(calculateVatWithholding({ taxableValue:'1000', isWithholdingAgent:true, supplierVatRegistered:true, standardRatedSupply:true, exempt:true }).withheldAmount, '0.00');
});

test('DT110/WHVAT due date is the 15th of the following month', () => {
  assert.equal(withholdingDueDate('2026-07-31'), '2026-08-15');
  assert.equal(withholdingDueDate('2026-12-31'), '2027-01-15');
});

test('GRA-3 migration separates income WHT and VAT withholding and creates frozen-return structures', () => {
  const sql = read('db/migrations/sql/150_gra3_withholding_compliance.sql');
  for (const token of [
    'GH_WHVAT_7',
    'ghana_withholding_events',
    'ghana_withholding_certificates',
    'ghana_withholding_returns',
    'ghana_withholding_return_lines',
    'ghana_withholding_remittance_events',
    'GH_DT110_2026',
    'GH_WHVAT_2026',
    'annual_cumulative',
    'withholding_regime',
  ]) assert.match(sql, new RegExp(token));
});

test('GRA-3 seeds current resident WHT categories missing from the prior pack', () => {
  const sql = read('db/migrations/sql/150_gra3_withholding_compliance.sql');
  for (const token of ['GH_WHT_EXAMINERS_TEACHERS_10','GH_WHT_COMMISSION_AGENTS_10','GH_WHT_PRECIOUS_MINERALS_3','GH_WHT_ROYALTY_NATURAL_RESOURCES_15']) {
    assert.match(sql, new RegExp(token));
  }
});

test('GRA-3 tax settings distinguish income-WHT and WHVAT agent/account configuration', () => {
  const validator = read('core/accounting/tax/tax.validators.js');
  const service = read('core/accounting/tax/tax.service.js');
  for (const token of ['ghIncomeWhtAgentEnabled','ghVatWithholdingAgentEnabled','ghWhtAnnualThreshold','ghVatWithholdingRate','vatWithholdingPayableAccountId']) {
    assert.match(validator, new RegExp(token));
  }
  assert.match(service, /gh_income_wht_agent_enabled/);
  assert.match(service, /vat_withholding_payable_account_id/);
});

test('partner tax profiles can carry exemptions and VAT-withholding eligibility', () => {
  const validator = read('core/accounting/tax/tax.validators.js');
  const service = read('core/accounting/tax/tax.service.js');
  for (const token of ['withholdingExempt','withholdingExemptionReference','defaultWithholdingCategory','vatWithholdingEligible']) {
    assert.match(validator, new RegExp(token));
  }
  assert.match(service, /withholding_exempt/);
  assert.match(service, /vat_withholding_eligible/);
});

test('payment posting captures withholding events and payment void reverses their compliance state', () => {
  const src = read('modules/transactions/payments/vendor-payments/vendorPayments.service.js');
  assert.match(src, /captureVendorPaymentWithholding/);
  assert.match(src, /voidVendorPaymentWithholding/);
});

test('GRA-3 service supports threshold, certificates, remittances, frozen returns and reconciliation', () => {
  const src = read('core/accounting/tax/ghanaWithholding.service.js');
  for (const token of ['getThresholdPosition','recordEvent','listCertificates','prepareReturn','finalizeReturn','createRemittanceFromEvents','postRemittance','getReconciliation']) {
    assert.match(src, new RegExp(token));
  }
  assert.match(src, /tax_registration_no/);
  assert.match(src, /return_id IS NULL/);
});

test('GRA-3 API exposes DT110/WHVAT workflows', () => {
  const src = read('core/accounting/tax/tax.routes.js');
  for (const route of ['/ghana/withholding/preview','/ghana/withholding/events','/ghana/withholding/certificates','/ghana/withholding/returns','/ghana/withholding/remittances','/ghana/withholding/reconciliation']) {
    assert.ok(src.includes(route), `missing route ${route}`);
  }
});

test('GRA-3 supports recording received income-WHT and WHVAT credit certificates', () => {
  const validator = read('core/accounting/tax/tax.validators.js');
  const service = read('core/accounting/tax/ghanaWithholding.service.js');
  const routes = read('core/accounting/tax/tax.routes.js');
  assert.match(validator, /ghReceivedWithholdingCertificateSchema/);
  assert.match(service, /recordReceivedCertificate/);
  assert.match(service, /'received'/);
  assert.ok(routes.includes('/ghana/withholding/certificates/received'));
});

test('received WHVAT certificates reduce the Ghana VAT net payable as a separate credit', () => {
  const reporting = read('reporting/tax/tax.service.js');
  assert.match(reporting, /ghanaVatWithholdingCredits/);
  assert.match(reporting, /vat_withholding_credit/);
  assert.match(reporting, /net_tax_payable_before_vat_withholding_credit/);
  assert.match(reporting, /regime='vat_withholding'/);
  assert.match(reporting, /direction='receivable'/);
});

test('GRA-3 blocks finalizing a withholding return when a withholdee TIN/GUIN is missing', () => {
  const service = read('core/accounting/tax/ghanaWithholding.service.js');
  assert.match(service, /partner TIN\/GUIN/);
  assert.match(service, /partner_tax_identifier/);
  assert.match(service, /missing_count/);
});

test('vendor payment posting settles A/P with cash plus WHVAT and credits the WHVAT payable account', () => {
  const svc = read('modules/transactions/payments/vendor-payments/vendorPayments.service.js');
  const migration = read('db/migrations/sql/150_gra3_withholding_compliance.sql');
  assert.match(svc, /computeVendorBillVatWithholding/);
  assert.match(svc, /vat_withholding_applied/);
  assert.match(svc, /VAT withholding payable/);
  assert.match(svc, /vatWithholdingCents/);
  assert.match(migration, /vat_withholding_basis/);
  assert.match(migration, /amount_applied \+ COALESCE\(vpa\.discount_taken,0\) \+ COALESCE\(vpa\.vat_withholding_applied,0\)/);
});
