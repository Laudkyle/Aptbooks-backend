const { pool } = require('../../../../db/pool');
const { withTransaction } = require('../../../../db/tx');
const { AppError } = require('../../../../shared/errors/AppError');
const journalIF = require('../../../../interfaces/journalPosting.interface');
const periodIF = require('../../../../interfaces/periodManagement.interface');
const { toCents, fromCents, percentOfCents, summarizeGhanaPayroll } = require('./ghanaPayroll');

function isoDate(v) { return new Date(v).toISOString().slice(0, 10); }
function monthEnd(date) {
  const d = new Date(`${isoDate(date)}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}
function addDays(date, days) {
  const d = new Date(`${isoDate(date)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

async function getRule(code, onDate, client = pool) {
  const { rows } = await client.query(
    `SELECT * FROM ghana_payroll_rule_versions
     WHERE code=$1 AND status='active' AND effective_from <= $2::date
       AND (effective_to IS NULL OR effective_to >= $2::date)
     ORDER BY effective_from DESC LIMIT 1`,
    [code, onDate]
  );
  if (!rows[0]) throw new AppError(409, `No active Ghana payroll rule ${code} for ${onDate}`);
  return rows[0];
}

async function getSettings({ orgId, client = pool }) {
  const { rows } = await client.query(`SELECT * FROM ghana_payroll_settings WHERE organization_id=$1`, [orgId]);
  return rows[0] || null;
}

async function ensureSettings({ orgId, actorUserId = null, client = pool }) {
  await client.query(
    `INSERT INTO ghana_payroll_settings(organization_id,enabled,updated_by)
     VALUES($1,FALSE,$2) ON CONFLICT (organization_id) DO NOTHING`,
    [orgId, actorUserId]
  );
  return getSettings({ orgId, client });
}

async function updateSettings({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => {
    await ensureSettings({ orgId, actorUserId, client });
    const fields=[]; const values=[orgId]; let i=2;
    const map={
      enabled:'enabled', payeEnabled:'paye_enabled', ssnitEnabled:'ssnit_enabled', tier2Enabled:'tier2_enabled',
      payePayableAccountId:'paye_payable_account_id', ssnitTier1PayableAccountId:'ssnit_tier1_payable_account_id',
      tier2PayableAccountId:'tier2_payable_account_id', employerPensionExpenseAccountId:'employer_pension_expense_account_id',
      defaultTier2SchemeName:'default_tier2_scheme_name', graTaxOffice:'gra_tax_office', employerTaxId:'employer_tax_id',
      ssnitEmployerNumber:'ssnit_employer_number', metadata:'metadata'
    };
    for (const [k,col] of Object.entries(map)) {
      if (payload[k] !== undefined) { fields.push(`${col}=$${i++}`); values.push(payload[k]); }
    }
    if (!fields.length) return getSettings({orgId,client});
    fields.push(`updated_by=$${i++}`); values.push(actorUserId);
    fields.push('updated_at=NOW()');
    const {rows}=await client.query(`UPDATE ghana_payroll_settings SET ${fields.join(',')} WHERE organization_id=$1 RETURNING *`,values);
    const out=rows[0];
    if (out.enabled) {
      if (out.paye_enabled && !out.paye_payable_account_id) throw new AppError(409,'PAYE payable account is required before Ghana payroll can be enabled');
      if (out.ssnit_enabled && (!out.ssnit_tier1_payable_account_id || !out.employer_pension_expense_account_id)) throw new AppError(409,'SSNIT payable and employer pension expense accounts are required before Ghana payroll can be enabled');
      if (out.ssnit_enabled && out.tier2_enabled && !out.tier2_payable_account_id) throw new AppError(409,'Tier 2 payable account is required before Ghana payroll can be enabled');
    }
    return out;
  });
}

async function getEngineContext({ orgId, payDate, client = pool }) {
  const settings = await getSettings({ orgId, client });
  if (!settings?.enabled) return null;
  const payeRule = await getRule('GH_PAYE', payDate, client);
  const pensionRule = await getRule('GH_SSNIT', payDate, client);
  const p = payeRule.rules_json || {};
  const s = pensionRule.rules_json || {};
  return {
    settings,
    payeRule,
    pensionRule,
    engine: {
      minimumInsurable: settings.ssnit_enabled ? (s.minimumInsurableEarnings || '0.00') : '0.00',
      maximumInsurable: settings.ssnit_enabled ? (s.maximumInsurableEarnings || null) : null,
      employeePensionRate: settings.ssnit_enabled ? (s.employeeRate || '5.50') : '0.00',
      employerPensionRate: settings.ssnit_enabled ? (s.employerRate || '13.00') : '0.00',
      ssnitRemittanceRate: settings.ssnit_enabled ? (s.ssnitRemittanceRate || '13.50') : '0.00',
      minimumSsnitRemittance: settings.ssnit_enabled ? (s.minimumSsnitRemittance || null) : null,
      maximumSsnitRemittance: settings.ssnit_enabled ? (s.maximumSsnitRemittance || null) : null,
      tier2Rate: settings.ssnit_enabled && settings.tier2_enabled ? (s.tier2Rate || '5.00') : '0.00',
      payeBands: settings.paye_enabled ? (p.residentMonthlyBands || []) : [],
      nonResidentRate: settings.paye_enabled ? (p.nonResidentRate || '25.00') : '0.00',
      nonResidentBonusOvertimeRate: settings.paye_enabled ? (p.nonResidentBonusOvertimeRate || '20.00') : '0.00',
      casualRate: settings.paye_enabled ? (p.casualWorkerRate || '5.00') : '0.00',
      partTimeResidentRate: settings.paye_enabled ? (p.partTimeResidentRate || '10.00') : '0.00',
      bonusConcessionRate: settings.paye_enabled ? (p.bonusConcessionRate || '5.00') : '0.00',
      bonusConcessionPercent: p.bonusConcessionPercentOfAnnualBasic || '15.00',
      overtimeLowerRate: settings.paye_enabled ? (p.overtimeLowerRate || '5.00') : '0.00',
      overtimeUpperRate: settings.paye_enabled ? (p.overtimeUpperRate || '10.00') : '0.00',
      overtimeThresholdPercent: p.overtimeThresholdPercentOfMonthlyBasic || '50.00',
      overtimeConcessionAnnualIncomeLimit: p.overtimeConcessionAnnualIncomeLimit || '18000.00',
    }
  };
}

async function loadYtdBonusMap({ orgId, payDate, client = pool }) {
  const y = new Date(payDate).getUTCFullYear();
  const { rows } = await client.query(
    `SELECT l.employee_id,
            COALESCE(SUM(COALESCE((l.breakdown_json->'ghana'->>'bonus')::numeric,0)),0)::text AS bonus
       FROM hr_payroll_run_lines l
       JOIN hr_payroll_runs r ON r.id=l.payroll_run_id AND r.organization_id=l.organization_id
      WHERE l.organization_id=$1 AND r.status IN ('approved','posted')
        AND EXTRACT(YEAR FROM r.pay_date)=$2 AND r.pay_date < $3::date
      GROUP BY l.employee_id`,
    [orgId, y, payDate]
  );
  return new Map(rows.map(r => [String(r.employee_id), r.bonus || '0.00']));
}

function assignmentAmountCents(baseCents, assignment, component) {
  if (component.calculation_method === 'percent_base') {
    return percentOfCents(baseCents, assignment.percent ?? 0);
  }
  return toCents(assignment.amount ?? 0);
}

function percentageAmountCents(basisCents, rate) { return percentOfCents(basisCents, rate ?? 0); }

function buildGhanaEmployeeLine({ employee, baseSalary, assignments, componentById, benefits, context, ytdBonusBeforeCurrent = '0.00', currency='GHS' }) {
  const baseCents=toCents(baseSalary);
  let regular=0n, bonus=0n, overtime=0n, nonTaxable=0n, otherDeductions=0n, extraRelief=0n;
  const earningBreakdown=[]; const deductionBreakdown=[];

  for (const a of assignments) {
    const c=componentById.get(String(a.component_id)); if (!c) continue;
    const amt=assignmentAmountCents(baseCents,a,c); if (!amt) continue;
    const cat=c.ghana_category || (c.is_taxable ? 'regular' : 'non_taxable');
    if (c.kind === 'earning') {
      if (cat==='bonus') bonus+=amt;
      else if (cat==='overtime') overtime+=amt;
      else if (cat==='non_taxable') nonTaxable+=amt;
      else regular+=amt;
      earningBreakdown.push({component_id:c.id,code:c.code,amount:fromCents(amt),ghana_category:cat});
    } else if (cat==='relief') {
      extraRelief+=amt;
    } else {
      otherDeductions+=amt;
      deductionBreakdown.push({component_id:c.id,code:c.code,amount:fromCents(amt),liability_account_id:c.liability_account_id,ghana_category:cat});
    }
  }

  let benefitEmployee=0n, benefitEmployer=0n;
  const benefitBreakdown=[];
  const grossForBenefits=baseCents+regular+bonus+overtime+nonTaxable;
  for (const b of benefits || []) {
    const basis=(b.base_on||'base')==='gross' ? grossForBenefits : baseCents;
    let emp=percentageAmountCents(basis,b.employee_rate);
    let empr=percentageAmountCents(basis,b.employer_rate);
    if (b.cap_amount) {
      const cap=toCents(b.cap_amount); if(emp>cap)emp=cap; if(empr>cap)empr=cap;
    }
    benefitEmployee+=emp; benefitEmployer+=empr;
    if (emp || empr) benefitBreakdown.push({code:b.plan_code,plan_name:b.plan_name,employee_amount:fromCents(emp),employer_amount:fromCents(empr),expense_account_id:b.expense_account_id,liability_account_id:b.liability_account_id});
  }
  otherDeductions += benefitEmployee;

  const relief=toCents(employee.approved_monthly_tax_relief || 0)+extraRelief;
  const calc=summarizeGhanaPayroll({
    baseSalary:fromCents(baseCents), regularEarnings:fromCents(regular), bonus:fromCents(bonus), overtime:fromCents(overtime),
    nonTaxableEarnings:fromCents(nonTaxable), otherDeductions:fromCents(otherDeductions), relief:fromCents(relief),
    employee, settings:context.engine, ytdBonusBeforeCurrent
  });

  const pensionEmployee=toCents(calc.pension.employeeContribution);
  const pensionEmployer=toCents(calc.pension.employerContribution);
  const tier2=toCents(calc.pension.tier2Payable);
  const tier1=toCents(calc.pension.ssnitTier1Payable);
  const tier1Employer= tier1 > pensionEmployee ? tier1-pensionEmployee : 0n;
  const paye=toCents(calc.paye.totalTax);
  const statutory=[];
  if (context.settings.paye_enabled && paye) statutory.push({code:'GH_PAYE',name:'Ghana PAYE',rule_type:'income_tax',employee_amount:fromCents(paye),employer_amount:'0.00',liability_account_id:context.settings.paye_payable_account_id,expense_account_id:null});
  if (context.settings.ssnit_enabled && (pensionEmployee || tier1Employer)) statutory.push({code:'GH_SSNIT_TIER1',name:'SSNIT Tier 1/NHIA remittance',rule_type:'social_security',employee_amount:fromCents(pensionEmployee),employer_amount:fromCents(tier1Employer),liability_account_id:context.settings.ssnit_tier1_payable_account_id,expense_account_id:context.settings.employer_pension_expense_account_id});
  if (context.settings.tier2_enabled && tier2) statutory.push({code:'GH_TIER2',name:'Mandatory Tier 2 pension',rule_type:'pension',employee_amount:'0.00',employer_amount:fromCents(tier2),liability_account_id:context.settings.tier2_payable_account_id,expense_account_id:context.settings.employer_pension_expense_account_id});

  const totalEmployer= pensionEmployer + benefitEmployer;
  const gross=toCents(calc.grossPay);
  const totalDeductions=toCents(calc.totalDeductions);
  const net=toCents(calc.netPay);
  const taxableEarnings=baseCents+regular+bonus+overtime;

  return {
    employee_id:employee.id,
    base_salary:fromCents(baseCents), total_earnings:fromCents(gross-baseCents), total_deductions:fromCents(totalDeductions),
    employer_contributions:fromCents(totalEmployer), gross_pay:fromCents(gross), net_pay:fromCents(net), currency,
    taxable_earnings:fromCents(taxableEarnings), chargeable_income:calc.paye.chargeableIncome || '0.00', paye_tax:calc.paye.totalTax || '0.00',
    bonus_tax:calc.paye.bonusTax || '0.00', overtime_tax:calc.paye.overtimeTax || '0.00', insurable_earnings:calc.pension.insurableEarnings || '0.00',
    ssnit_employee:calc.pension.employeeContribution || '0.00', ssnit_employer:calc.pension.employerContribution || '0.00',
    ssnit_tier1_payable:calc.pension.ssnitTier1Payable || '0.00', tier2_payable:calc.pension.tier2Payable || '0.00', total_employer_cost:fromCents(gross+totalEmployer),
    breakdown:{
      base_salary:fromCents(baseCents), earnings:earningBreakdown, deductions:deductionBreakdown, statutory, benefits:benefitBreakdown,
      employer_contributions_total:fromCents(totalEmployer),
      ghana:{
        rule_versions:{paye:context.payeRule.id,pension:context.pensionRule.id}, regular_earnings:fromCents(regular), bonus:fromCents(bonus), overtime:fromCents(overtime), non_taxable_earnings:fromCents(nonTaxable),
        approved_relief:fromCents(relief), paye:calc.paye, pension:calc.pension, tax_residency:employee.tax_residency||'resident', worker_classification:employee.worker_classification||'regular'
      }
    }
  };
}

async function prepareReturn({ orgId, actorUserId, formCode, periodStart, periodEnd }) {
  if (!['DT107','DT108'].includes(formCode)) throw new AppError(400,'formCode must be DT107 or DT108');
  const start=isoDate(periodStart), end=isoDate(periodEnd); const taxYear=new Date(`${start}T00:00:00Z`).getUTCFullYear();
  const {rows}=await pool.query(
    `SELECT l.*,e.employee_no,e.first_name,e.last_name,e.other_names,e.tax_id,e.ghana_card_pin,e.ssnit_number,e.worker_classification,e.tax_residency,
            r.id AS source_run_id,r.pay_date
       FROM hr_payroll_run_lines l
       JOIN hr_payroll_runs r ON r.id=l.payroll_run_id AND r.organization_id=l.organization_id
       JOIN hr_employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id
      WHERE l.organization_id=$1 AND r.status='posted' AND r.statutory_country_code='GH'
        AND r.pay_date BETWEEN $2::date AND $3::date
      ORDER BY e.employee_no,r.pay_date`,[orgId,start,end]);
  if(!rows.length) throw new AppError(409,'No posted Ghana payroll runs found for the selected period');

  const byEmp=new Map();
  for(const r of rows){
    const k=String(r.employee_id); if(!byEmp.has(k)) byEmp.set(k,{employee:r,runs:[],basic:0n,other:0n,bonus:0n,overtime:0n,gross:0n,ssnit:0n,chargeable:0n,paye:0n,bonusTax:0n,overtimeTax:0n});
    const a=byEmp.get(k), g=r.breakdown_json?.ghana||{};
    a.runs.push(r.source_run_id); a.basic+=toCents(r.base_salary); a.gross+=toCents(r.gross_pay); a.ssnit+=toCents(r.ssnit_employee); a.chargeable+=toCents(r.chargeable_income); a.paye+=toCents(r.paye_tax); a.bonusTax+=toCents(r.bonus_tax); a.overtimeTax+=toCents(r.overtime_tax); a.bonus+=toCents(g.bonus||0); a.overtime+=toCents(g.overtime||0);
    const regular=toCents(g.regular_earnings||0), nonTax=toCents(g.non_taxable_earnings||0); a.other+=regular+nonTax;
  }
  return withTransaction(async client=>{
    const {rows:vr}=await client.query(`SELECT COALESCE(MAX(version_no),0)+1 AS v FROM ghana_paye_returns WHERE organization_id=$1 AND form_code=$2 AND period_start=$3 AND period_end=$4`,[orgId,formCode,start,end]);
    const version=Number(vr[0].v);
    let tb=0n,tg=0n,tc=0n,tp=0n,tbt=0n,tot=0n,ts=0n;
    const {rows:retRows}=await client.query(`INSERT INTO ghana_paye_returns(organization_id,form_code,period_start,period_end,tax_year,version_no,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[orgId,formCode,start,end,taxYear,version,actorUserId]);
    const ret=retRows[0];
    for(const a of byEmp.values()){
      const e=a.employee; tb+=a.basic; tg+=a.gross; tc+=a.chargeable; tp+=a.paye; tbt+=a.bonusTax; tot+=a.overtimeTax; ts+=a.ssnit;
      const graduated=a.paye-a.bonusTax-a.overtimeTax;
      await client.query(`INSERT INTO ghana_paye_return_lines(organization_id,return_id,employee_id,employee_no,employee_name,employee_tax_id,ghana_card_pin,ssnit_number,worker_classification,tax_residency,basic_salary,other_cash_emoluments,bonus,overtime,gross_pay,ssnit_employee,chargeable_income,graduated_paye,bonus_tax,overtime_tax,total_paye,source_run_ids,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,[orgId,ret.id,e.employee_id,e.employee_no,[e.first_name,e.other_names,e.last_name].filter(Boolean).join(' '),e.tax_id,e.ghana_card_pin,e.ssnit_number,e.worker_classification,e.tax_residency,fromCents(a.basic),fromCents(a.other),fromCents(a.bonus),fromCents(a.overtime),fromCents(a.gross),fromCents(a.ssnit),fromCents(a.chargeable),fromCents(graduated),fromCents(a.bonusTax),fromCents(a.overtimeTax),fromCents(a.paye),a.runs,{periodStart:start,periodEnd:end}]);
    }
    const {rows:updated}=await client.query(`UPDATE ghana_paye_returns SET total_basic_salary=$2,total_gross_pay=$3,total_chargeable_income=$4,total_paye=$5,total_bonus_tax=$6,total_overtime_tax=$7,total_ssnit_employee=$8 WHERE id=$1 RETURNING *`,[ret.id,fromCents(tb),fromCents(tg),fromCents(tc),fromCents(tp),fromCents(tbt),fromCents(tot),fromCents(ts)]);
    return getReturn({orgId,returnId:updated[0].id,client});
  });
}

async function listReturns({orgId}) { const {rows}=await pool.query(`SELECT * FROM ghana_paye_returns WHERE organization_id=$1 ORDER BY period_end DESC,version_no DESC`,[orgId]); return rows; }
async function getReturn({orgId,returnId,client=pool}) { const {rows}=await client.query(`SELECT * FROM ghana_paye_returns WHERE organization_id=$1 AND id=$2`,[orgId,returnId]); if(!rows[0])throw new AppError(404,'PAYE return not found'); const {rows:lines}=await client.query(`SELECT * FROM ghana_paye_return_lines WHERE organization_id=$1 AND return_id=$2 ORDER BY employee_no`,[orgId,returnId]); const scheduleCode=rows[0].form_code==='DT107'?'DT107A':'DT108A'; return {...rows[0],schedule_code:scheduleCode,lines}; }
async function finalizeReturn({orgId,actorUserId,returnId}) { return withTransaction(async client=>{ const ret=await getReturn({orgId,returnId,client}); if(ret.status!=='draft')throw new AppError(409,'Only draft PAYE returns can be finalized'); const missing=ret.lines.filter(l=>!l.employee_tax_id&&!l.ghana_card_pin); if(missing.length)throw new AppError(409,`Cannot finalize: ${missing.length} employee(s) have no TIN/Ghana Card PIN`); await client.query(`UPDATE ghana_paye_returns SET status='finalized',finalized_at=NOW(),finalized_by=$3 WHERE organization_id=$1 AND id=$2`,[orgId,returnId,actorUserId]); return getReturn({orgId,returnId,client}); }); }
async function markFiled({orgId,actorUserId,returnId,graReference}) { return withTransaction(async client=>{ const ret=await getReturn({orgId,returnId,client}); if(ret.status!=='finalized')throw new AppError(409,'PAYE return must be finalized before filing'); await client.query(`UPDATE ghana_paye_returns SET status='filed',filed_at=NOW(),filed_by=$3,gra_reference=$4 WHERE organization_id=$1 AND id=$2`,[orgId,returnId,actorUserId,graReference||null]); return getReturn({orgId,returnId,client}); }); }

function csvEscape(v){ const s=String(v??''); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; }
async function exportReturnCsv({orgId,returnId}) { const ret=await getReturn({orgId,returnId}); const headers=['Employee No','Employee Name','TIN','Ghana Card PIN','SSNIT No','Basic Salary','Other Cash Emoluments','Bonus','Overtime','Gross Pay','Employee SSNIT','Chargeable Income','Graduated PAYE','Bonus Tax','Overtime Tax','Total PAYE']; const lines=[headers.join(',')]; for(const r of ret.lines) lines.push([r.employee_no,r.employee_name,r.employee_tax_id,r.ghana_card_pin,r.ssnit_number,r.basic_salary,r.other_cash_emoluments,r.bonus,r.overtime,r.gross_pay,r.ssnit_employee,r.chargeable_income,r.graduated_paye,r.bonus_tax,r.overtime_tax,r.total_paye].map(csvEscape).join(',')); return {formCode:ret.form_code,scheduleCode:ret.schedule_code,filename:`${ret.schedule_code}-${ret.period_start}-${ret.period_end}-v${ret.version_no}.csv`,content:lines.join('\n')}; }

async function contributionSchedule({orgId,periodStart,periodEnd}) {
  if (!periodStart || !periodEnd) throw new AppError(400,'periodStart and periodEnd are required');
  const {rows}=await pool.query(`SELECT e.employee_no,e.first_name,e.last_name,e.ghana_card_pin,e.ssnit_number,e.tier2_member_id,COALESCE(e.tier2_scheme_name,s.default_tier2_scheme_name) AS tier2_scheme_name,
      SUM(l.insurable_earnings)::text AS insurable_earnings,SUM(l.ssnit_employee)::text AS employee_contribution,SUM(l.ssnit_employer)::text AS employer_contribution,SUM(l.ssnit_tier1_payable)::text AS ssnit_tier1_payable,SUM(l.tier2_payable)::text AS tier2_payable
    FROM hr_payroll_run_lines l JOIN hr_payroll_runs r ON r.id=l.payroll_run_id AND r.organization_id=l.organization_id JOIN hr_employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id LEFT JOIN ghana_payroll_settings s ON s.organization_id=l.organization_id
    WHERE l.organization_id=$1 AND r.status='posted' AND r.statutory_country_code='GH' AND r.pay_date BETWEEN $2::date AND $3::date
    GROUP BY e.id,e.employee_no,e.first_name,e.last_name,e.ghana_card_pin,e.ssnit_number,e.tier2_member_id,e.tier2_scheme_name,s.default_tier2_scheme_name ORDER BY e.employee_no`,[orgId,periodStart,periodEnd]);
  return {periodStart,periodEnd,lines:rows,totals:rows.reduce((a,r)=>{for(const k of ['insurable_earnings','employee_contribution','employer_contribution','ssnit_tier1_payable','tier2_payable'])a[k]=fromCents(toCents(a[k]||0)+toCents(r[k]||0));return a;},{})};
}

async function disengagedSchedule({orgId,periodStart,periodEnd}) { if(!periodStart||!periodEnd) throw new AppError(400,'periodStart and periodEnd are required'); const {rows}=await pool.query(`SELECT employee_no,first_name,last_name,other_names,tax_id,ghana_card_pin,ssnit_number,employment_end_date FROM hr_employees WHERE organization_id=$1 AND employment_end_date BETWEEN $2::date AND $3::date ORDER BY employment_end_date,employee_no`,[orgId,periodStart,periodEnd]); return {formCode:'DT107C',periodStart,periodEnd,lines:rows}; }

async function prepareRemittance({orgId,actorUserId,type,periodStart,periodEnd}) {
  if(!periodStart||!periodEnd) throw new AppError(400,'periodStart and periodEnd are required');
  if(!['PAYE','SSNIT_TIER1','TIER2'].includes(type))throw new AppError(400,'Invalid remittance type');
  const column=type==='PAYE'?'paye_tax':type==='SSNIT_TIER1'?'ssnit_tier1_payable':'tier2_payable';
  const {rows}=await pool.query(`SELECT COALESCE(SUM(l.${column}),0)::text AS amount FROM hr_payroll_run_lines l JOIN hr_payroll_runs r ON r.id=l.payroll_run_id AND r.organization_id=l.organization_id WHERE l.organization_id=$1 AND r.status='posted' AND r.statutory_country_code='GH' AND r.pay_date BETWEEN $2::date AND $3::date`,[orgId,periodStart,periodEnd]);
  const end=monthEnd(periodEnd); const due=type==='PAYE'?addDays(end,15):addDays(end,14);
  const {rows:out}=await pool.query(`INSERT INTO ghana_payroll_remittances(organization_id,remittance_type,period_start,period_end,due_date,amount,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,remittance_type,period_start,period_end) DO UPDATE SET amount=EXCLUDED.amount,due_date=EXCLUDED.due_date WHERE ghana_payroll_remittances.status='prepared' RETURNING *`,[orgId,type,periodStart,periodEnd,due,rows[0].amount,actorUserId]);
  if(!out[0])throw new AppError(409,'Existing remittance is not editable'); return out[0];
}
async function listRemittances({orgId}) { const {rows}=await pool.query(`SELECT * FROM ghana_payroll_remittances WHERE organization_id=$1 ORDER BY period_end DESC,remittance_type`,[orgId]); return rows; }
async function markRemittancePaid({orgId,id,actorUserId,settlementAccountId,paymentDate,paymentReference}) {
  if (!settlementAccountId) throw new AppError(400,'settlementAccountId is required');
  if (!paymentDate) throw new AppError(400,'paymentDate is required');
  return withTransaction(async client=>{
    const {rows}=await client.query(`SELECT * FROM ghana_payroll_remittances WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[orgId,id]);
    if(!rows[0]) throw new AppError(404,'Payroll remittance not found');
    const rem=rows[0];
    if(rem.status!=='prepared') throw new AppError(409,'Remittance must be prepared before marking paid');
    if(toCents(rem.amount)<=0n) throw new AppError(409,'Remittance amount must be greater than zero');

    const settings=await getSettings({orgId,client});
    if(!settings) throw new AppError(409,'Ghana payroll settings are not configured');
    const payableAccountId = rem.remittance_type==='PAYE'
      ? settings.paye_payable_account_id
      : rem.remittance_type==='SSNIT_TIER1'
        ? settings.ssnit_tier1_payable_account_id
        : settings.tier2_payable_account_id;
    if(!payableAccountId) throw new AppError(409,`${rem.remittance_type} payable account is not configured`);

    const period=await periodIF.findOpenPeriodForDate({orgId,date:paymentDate,client});
    const draft=await journalIF.createDraftJournal({
      orgId,actorUserId,client,payload:{
        periodId:period.id,entryDate:paymentDate,typeCode:'GENERAL',
        memo:`Ghana payroll statutory remittance ${rem.remittance_type} ${rem.period_start} to ${rem.period_end}`,
        idempotencyKey:`ghana_payroll_remittance:${id}:paid`,
        lines:[
          {accountId:payableAccountId,debit:fromCents(toCents(rem.amount)),credit:'0.00',description:`Clear ${rem.remittance_type} payroll liability`},
          {accountId:settlementAccountId,debit:'0.00',credit:fromCents(toCents(rem.amount)),description:`${rem.remittance_type} statutory payment`},
        ],
      },
    });
    const posted=await journalIF.postDraftJournal({orgId,journalId:draft.journalId,actorUserId,client});
    const {rows:updated}=await client.query(`UPDATE ghana_payroll_remittances SET status='paid',paid_at=NOW(),paid_by=$4,payment_reference=$3,settlement_account_id=$5,journal_entry_id=$6 WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,id,paymentReference||null,actorUserId,settlementAccountId,posted.journalId]);
    return updated[0];
  });
}

module.exports={getSettings,ensureSettings,updateSettings,getEngineContext,loadYtdBonusMap,buildGhanaEmployeeLine,prepareReturn,listReturns,getReturn,finalizeReturn,markFiled,exportReturnCsv,contributionSchedule,disengagedSchedule,prepareRemittance,listRemittances,markRemittancePaid};
