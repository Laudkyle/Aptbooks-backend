const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  calculatePaye, calculatePension, summarizeGhanaPayroll, computeBaseSalaryForPeriod,
} = require('../modules/hr/payroll/ghana/ghanaPayroll');

const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const bands=[
  {amount:'490.00',rate:'0.00'}, {amount:'110.00',rate:'5.00'}, {amount:'130.00',rate:'10.00'},
  {amount:'3166.67',rate:'17.50'}, {amount:'16000.00',rate:'25.00'}, {amount:'30520.00',rate:'30.00'},
  {amount:null,rate:'35.00'},
];
const settings={minimumInsurable:'587.80',maximumInsurable:'69000.00',minimumSsnitRemittance:'79.40',maximumSsnitRemittance:'9315.00',employeePensionRate:'5.50',employerPensionRate:'13.00',ssnitRemittanceRate:'13.50',tier2Rate:'5.00',payeBands:bands,nonResidentRate:'25.00',nonResidentBonusOvertimeRate:'20.00',casualRate:'5.00',partTimeResidentRate:'10.00',bonusConcessionRate:'5.00',bonusConcessionPercent:'15.00',overtimeLowerRate:'5.00',overtimeUpperRate:'10.00',overtimeThresholdPercent:'50.00',overtimeConcessionAnnualIncomeLimit:'18000.00'};

test('2026 SSNIT contribution splits 18.5% into 13.5% SSNIT and 5% Tier 2',()=>{
  const out=calculatePension({monthlyBasic:'1000',minimumInsurable:'587.80',maximumInsurable:'69000',employeeRate:'5.5',employerRate:'13',ssnitRemittanceRate:'13.5',tier2Rate:'5',minimumSsnitRemittance:'79.40',maximumSsnitRemittance:'9315.00'});
  assert.equal(out.employeeContribution,'55.00'); assert.equal(out.employerContribution,'130.00');
  assert.equal(out.ssnitTier1Payable,'135.00'); assert.equal(out.tier2Payable,'50.00'); assert.equal(out.totalContribution,'185.00');
});

test('2026 SSNIT maximum insurable earnings is GH¢69,000 and Tier-1 remittance caps at GH¢9,315',()=>{
  const out=calculatePension({monthlyBasic:'100000',minimumInsurable:'587.80',maximumInsurable:'69000',employeeRate:'5.5',employerRate:'13',ssnitRemittanceRate:'13.5',tier2Rate:'5',minimumSsnitRemittance:'79.40',maximumSsnitRemittance:'9315.00'});
  assert.equal(out.insurableEarnings,'69000.00'); assert.equal(out.ssnitTier1Payable,'9315.00'); assert.equal(out.tier2Payable,'3450.00');
});

test('2026 SSNIT minimum insurable earnings is GH¢587.80',()=>{
  const out=calculatePension({monthlyBasic:'500',minimumInsurable:'587.80',maximumInsurable:'69000',employeeRate:'5.5',employerRate:'13',ssnitRemittanceRate:'13.5',tier2Rate:'5',minimumSsnitRemittance:'79.40',maximumSsnitRemittance:'9315.00'});
  assert.equal(out.insurableEarnings,'587.80'); assert.equal(out.ssnitTier1Payable,'79.40'); assert.equal(out.employerContribution,'76.46');
});

test('resident PAYE applies published progressive monthly bands with half-up rounding',()=>{
  const out=calculatePaye({regularTaxable:'1000',monthlyBasic:'1000',bands});
  assert.equal(out.totalTax,'65.75');
});

test('Ghana payroll deducts employee SSNIT before resident PAYE',()=>{
  const out=summarizeGhanaPayroll({baseSalary:'1000',regularEarnings:'0',employee:{tax_residency:'resident',worker_classification:'regular'},settings});
  assert.equal(out.pension.employeeContribution,'55.00'); assert.equal(out.paye.chargeableIncome,'945.00'); assert.equal(out.paye.totalTax,'56.13');
  assert.equal(out.netPay,'888.87');
});

test('non-resident employment chargeable income uses 25% flat PAYE',()=>{
  const out=calculatePaye({regularTaxable:'1000',monthlyBasic:'1000',residency:'nonresident',bands,nonResidentRate:'25'});
  assert.equal(out.totalTax,'250.00');
});

test('non-resident bonus and overtime use the GRA-published 20% special employment rate',()=>{
  const out=calculatePaye({regularTaxable:'1000',bonus:'100',overtime:'50',monthlyBasic:'1000',residency:'nonresident',bands,nonResidentRate:'25',nonResidentBonusOvertimeRate:'20'});
  assert.equal(out.graduatedTax,'250.00'); assert.equal(out.bonusTax,'20.00'); assert.equal(out.overtimeTax,'10.00'); assert.equal(out.totalTax,'280.00');
});

test('casual worker deduction is 5% final tax',()=>{
  const out=calculatePaye({regularTaxable:'1000',monthlyBasic:'1000',workerClassification:'casual',bands,casualRate:'5'});
  assert.equal(out.method,'casual_final'); assert.equal(out.totalTax,'50.00'); assert.equal(out.finalTax,'50.00');
});

test('bonus up to 15% of annual basic salary receives 5% concessionary tax',()=>{
  const out=calculatePaye({regularTaxable:'1000',bonus:'1000',monthlyBasic:'1000',annualBasic:'12000',bands});
  assert.equal(out.bonusConcessionAmount,'1000.00'); assert.equal(out.bonusTax,'50.00'); assert.equal(out.bonusExcessAmount,'0.00');
});

test('bonus above remaining 15% annual-basic limit pushes excess into graduated PAYE',()=>{
  const out=calculatePaye({regularTaxable:'1000',bonus:'1000',monthlyBasic:'1000',annualBasic:'12000',ytdBonusBeforeCurrent:'1500',bands});
  assert.equal(out.bonusConcessionAmount,'300.00'); assert.equal(out.bonusExcessAmount,'700.00'); assert.equal(out.bonusTax,'15.00');
  assert.ok(Number(out.graduatedTax)>65.75);
});

test('qualified junior overtime uses 5% up to 50% basic and 10% on excess',()=>{
  const out=calculatePaye({regularTaxable:'1000',overtime:'700',monthlyBasic:'1000',bands,qualifiesOvertimeConcession:true});
  assert.equal(out.overtimeTax,'45.00'); // 500*5% + 200*10%
});

test('overtime concession is not applied when qualifying annual employment income exceeds current GRA limit',()=>{
  const out=calculatePaye({regularTaxable:'2000',overtime:'700',monthlyBasic:'2000',annualBasic:'24000',bands,qualifiesOvertimeConcession:true,overtimeConcessionAnnualIncomeLimit:'18000'});
  assert.equal(out.overtimeTax,'0.00'); assert.ok(Number(out.graduatedTax) > 0);
});

test('weekly salary period conversion uses exact half-up division',()=>{
  assert.equal(computeBaseSalaryForPeriod({amount:'700',frequency:'weekly',startDate:'2026-08-01',endDate:'2026-08-31'}),'3100.00');
});

test('Release 4 migration versions Ghana PAYE/SSNIT rules and adds employee statutory identifiers',()=>{
  const sql=read('db/migrations/sql/151_gra4_ghana_payroll_paye_pensions.sql');
  for(const token of ['ghana_payroll_rule_versions','GH_PAYE','GH_SSNIT','69000.00','587.80','79.40','9315.00','nonResidentBonusOvertimeRate','overtimeConcessionAnnualIncomeLimit','ghana_card_pin','ssnit_number','tier2_member_id','tax_residency','worker_classification','ghana_paye_returns','ghana_paye_return_lines','ghana_payroll_remittances']) assert.match(sql,new RegExp(token));
});

test('generic statutory rules can be effective-dated without overwriting history',()=>{
  const sql=read('db/migrations/sql/151_gra4_ghana_payroll_paye_pensions.sql'); const repo=read('modules/hr/statutory/statutory.repository.js');
  assert.match(sql,/ux_hr_statutory_rules_org_code_effective/); assert.match(repo,/effective_from <=/);
});

test('Ghana payroll component categories distinguish bonus, overtime, non-taxable and relief',()=>{
  const migration=read('db/migrations/sql/151_gra4_ghana_payroll_paye_pensions.sql'); const validator=read('shared/validators/hr.payroll.validators.js');
  for(const token of ['bonus','overtime','non_taxable','relief','other_deduction']) {assert.match(migration,new RegExp(token));assert.match(validator,new RegExp(token));}
});

test('payroll journal aggregation uses integer minor units instead of round2 floats',()=>{
  const src=read('modules/hr/payroll/runs/payrollRuns.service.js');
  assert.match(src,/parseDecimalToBigInt\(l\.gross_pay/); assert.match(src,/sumD !== sumC/); assert.match(src,/bigIntToDecimalString/);
});

test('Release 4 exposes Ghana PAYE returns, pension/disengaged schedules and remittances',()=>{
  const routes=read('modules/hr/payroll/ghana/ghanaPayroll.routes.js');
  for(const route of ['/returns','/pension-schedule','/disengaged-schedule','/remittances','/settings']) assert.ok(routes.includes(route));
  assert.match(routes,/export\.csv/); const svc=read('modules/hr/payroll/ghana/ghanaPayroll.service.js'); assert.match(svc,/DT107A/); assert.match(svc,/DT108A/);
});

test('statutory remittance payment clears payroll liability through a posted journal',()=>{
  const svc=read('modules/hr/payroll/ghana/ghanaPayroll.service.js');
  const validator=read('shared/validators/hr.payroll.validators.js');
  assert.match(svc,/ghana_payroll_remittance:\$\{id\}:paid/);
  assert.match(svc,/findOpenPeriodForDate/);
  assert.match(svc,/postDraftJournal/);
  assert.match(svc,/settlement_account_id/);
  assert.match(validator,/settlementAccountId/);
  assert.match(validator,/paymentDate/);
});

test('PAYE return finalization blocks employees without tax identifiers',()=>{
  const svc=read('modules/hr/payroll/ghana/ghanaPayroll.service.js');
  assert.match(svc,/TIN\/Ghana Card PIN/); assert.match(svc,/employee_tax_id/); assert.match(svc,/ghana_card_pin/);
});
