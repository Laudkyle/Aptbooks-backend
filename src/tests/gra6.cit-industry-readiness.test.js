const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  calculateCitComputation,
  calculateSelfAssessment,
  splitQuarterlyInstalments,
  calculateCapitalAllowance,
  annualReturnDueDate,
  quarterlyInstalmentDueDates,
} = require('../shared/tax/ghanaCit');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('general Ghana CIT calculation uses percentage-point rates with fixed-point arithmetic', () => {
  const out = calculateCitComputation({ accountingProfit:'100000.00', addBacks:'10000.00', allowableDeductions:'5000.00', capitalAllowance:'15000.00', lossRelief:'0.00', taxRate:'25.000000' });
  assert.equal(out.adjustedProfit,'105000.00');
  assert.equal(out.chargeableIncome,'90000.00');
  assert.equal(out.grossTax,'22500.00');
});

test('CIT tax credits and instalments cannot drive net tax below zero and expose overpayment', () => {
  const out = calculateCitComputation({ accountingProfit:'10000', taxRate:'25', withholdingCredits:'1000', instalmentsPaid:'2000' });
  assert.equal(out.grossTax,'2500.00');
  assert.equal(out.taxAfterCredits,'1500.00');
  assert.equal(out.netTaxPayable,'0.00');
  assert.equal(out.overpayment,'500.00');
});

test('negative adjusted results never create negative chargeable income', () => {
  const out = calculateCitComputation({ accountingProfit:'-5000', allowableDeductions:'1000', taxRate:'25' });
  assert.equal(out.chargeableIncome,'0.00');
  assert.equal(out.grossTax,'0.00');
});

test('DT102 self assessment calculates estimated annual tax and exact four-way instalments', () => {
  const out = calculateSelfAssessment({ estimatedChargeableIncome:'100001.00', taxRate:'25' });
  assert.equal(out.estimatedAnnualTax,'25000.25');
  assert.deepEqual(splitQuarterlyInstalments(out.estimatedAnnualTax),['6250.07','6250.06','6250.06','6250.06']);
});

test('calendar-year quarterly due dates match March, June, September and December quarter ends', () => {
  assert.deepEqual(quarterlyInstalmentDueDates('2026-01-01'),['2026-03-31','2026-06-30','2026-09-30','2026-12-31']);
});

test('annual income return due date is four months after basis period end with month-end clamping', () => {
  assert.equal(annualReturnDueDate('2026-12-31'),'2027-04-30');
  assert.equal(annualReturnDueDate('2026-06-30'),'2026-10-30');
});

test('Class 1 capital allowance supports 40 percent reducing-balance calculation', () => {
  const out = calculateCapitalAllowance({ openingTaxWdv:'0', additions:'10000', rate:'40', daysInBasisPeriod:365, method:'reducing_balance' });
  assert.equal(out.capitalAllowance,'4000.00');
  assert.equal(out.closingTaxWdv,'6000.00');
});

test('Class 4 capital allowance supports 10 percent straight-line calculation', () => {
  const out = calculateCapitalAllowance({ openingTaxWdv:'0', additions:'100000', rate:'10', daysInBasisPeriod:365, method:'straight_line' });
  assert.equal(out.capitalAllowance,'10000.00');
  assert.equal(out.closingTaxWdv,'90000.00');
});

test('Class 5 intangible allowance is based on useful life', () => {
  const out = calculateCapitalAllowance({ additions:'50000', usefulLifeYears:5, daysInBasisPeriod:365, method:'useful_life' });
  assert.equal(out.capitalAllowance,'10000.00');
});

test('straight-line classes keep annual allowance based on original tax cost rather than declining WDV', () => {
  const out = calculateCapitalAllowance({ openingTaxWdv:'90000', additions:'0', straightLineCostBasis:'100000', rate:'10', daysInBasisPeriod:365, method:'straight_line' });
  assert.equal(out.capitalAllowance,'10000.00');
  assert.equal(out.closingTaxWdv,'80000.00');
});

test('capital allowance is prorated by days in basis period using half-up arithmetic', () => {
  const out = calculateCapitalAllowance({ additions:'10000', rate:'40', daysInBasisPeriod:182, method:'reducing_balance' });
  assert.equal(out.capitalAllowance,'1994.52');
});

test('Release 6 migration versions CIT rates, models DT101/DT102, tax assets, industry packs and readiness', () => {
  const sql = read('db/migrations/sql/153_gra6_cit_industry_readiness.sql');
  for (const token of ['ghana_cit_rate_versions','GH_CIT_GENERAL','ghana_cit_computations','DT101','ghana_cit_self_assessments','DT102','DT102A','ghana_tax_asset_classes','GH_CA_CLASS_1','GH_CA_CLASS_5','ghana_tax_assets','ghana_capital_allowance_runs','ghana_industry_profiles','GH_HOSPITAL','GH_SCHOOL','GH_MART','ghana_readiness_snapshots']) assert.match(sql,new RegExp(token));
});

test('current capital allowance classes are seeded as 40, 30, 20, 10 and useful-life based', () => {
  const sql = read('db/migrations/sql/153_gra6_cit_industry_readiness.sql');
  assert.match(sql,/GH_CA_CLASS_1[\s\S]*40\.000000/);
  assert.match(sql,/GH_CA_CLASS_2[\s\S]*30\.000000/);
  assert.match(sql,/GH_CA_CLASS_3[\s\S]*20\.000000/);
  assert.match(sql,/GH_CA_CLASS_4[\s\S]*10\.000000/);
  assert.match(sql,/GH_CA_CLASS_5[\s\S]*useful_life/);
});

test('industry packs remain review-oriented rather than automatically declaring sector-wide exemptions', () => {
  const sql = read('db/migrations/sql/153_gra6_cit_industry_readiness.sql');
  assert.match(sql,/reviewRequired/);
  assert.match(sql,/classify_each_medical_service_or_item/);
  assert.match(sql,/classify_each_fee_or_service/);
  assert.match(sql,/classify_all_active_skus/);
});

test('CIT service derives accounting profit from posted journal history and uses finalized capital allowances/WHT credits', () => {
  const src = read('core/accounting/tax/ghanaCit.service.js');
  assert.match(src,/je\.status IN \('posted','voided'\)/);
  assert.match(src,/at\.code IN \('REVENUE','EXPENSE'\)/);
  assert.match(src,/ghana_capital_allowance_runs/);
  assert.match(src,/regime='income_wht' AND direction='receivable'/);
});

test('special CIT rates require explicit eligibility review before DT101 finalization', () => {
  const src = read('core/accounting/tax/ghanaCit.service.js');
  assert.match(src,/GH_CIT_GENERAL/);
  assert.match(src,/industry_rate_reviewed/);
  assert.match(src,/Review and confirm eligibility/);
});

test('Release 6 API exposes CIT, self assessment, capital allowances, industry profiles and readiness', () => {
  const routes = read('core/accounting/tax/tax.routes.js');
  for (const route of ['/ghana/cit/settings','/ghana/cit/rates','/ghana/cit/computations','/ghana/cit/self-assessments','/ghana/capital-allowances/classes','/ghana/capital-allowances/assets','/ghana/capital-allowances/runs','/ghana/industry-profiles','/ghana/readiness']) assert.ok(routes.includes(route));
});

test('GRA readiness checks tax identity, VAT/catalog, payroll, E-VAT, CIT, tax assets and industry setup', () => {
  const src = read('core/accounting/tax/ghanaCit.service.js');
  for (const token of ['ghana_pack','taxpayer_id','cit_enabled','vat_registration','catalog_classification','withholding_review','ghana_payroll','evat','tax_assets','industry_profile','fiscal_dead_letters']) assert.match(src,new RegExp(token));
});
