const { pool } = require('../../../db/pool');
const { withTransaction } = require('../../../db/tx');
const { AppError } = require('../../../shared/errors/AppError');
const {
  calculateCitComputation,
  calculateSelfAssessment,
  splitQuarterlyInstalments,
  calculateCapitalAllowance,
  annualReturnDueDate,
  quarterlyInstalmentDueDates,
} = require('../../../shared/tax/ghanaCit');
const { parseDecimalToBigInt, bigIntToDecimalString, divideAndRoundHalfUp } = require('../../../shared/utils/money');

function money(value) {
  return bigIntToDecimalString(parseDecimalToBigInt(value == null || value === '' ? '0' : String(value), 2), 2);
}

function assertDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new AppError(400, `${name} must be YYYY-MM-DD`);
}

function asPositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `${name} must be a positive integer`);
  return n;
}

async function ensureSettings({ orgId, client = pool }) {
  const { rows: generalRows } = await client.query(
    `SELECT id FROM ghana_cit_rate_versions WHERE code='GH_CIT_GENERAL' AND status='active' ORDER BY effective_from DESC LIMIT 1`,
  );
  if (!generalRows.length) throw new AppError(500, 'Ghana CIT general rate is not configured');
  await client.query(
    `INSERT INTO ghana_cit_settings(organization_id,default_rate_version_id) VALUES($1,$2) ON CONFLICT(organization_id) DO NOTHING`,
    [orgId, generalRows[0].id],
  );
  const { rows } = await client.query(
    `SELECT s.*,r.code AS rate_code,r.name AS rate_name,r.tax_rate,r.qualification_json,r.effective_from AS rate_effective_from,r.effective_to AS rate_effective_to
       FROM ghana_cit_settings s
       LEFT JOIN ghana_cit_rate_versions r ON r.id=s.default_rate_version_id
      WHERE s.organization_id=$1`,
    [orgId],
  );
  return rows[0];
}

async function getSettings({ orgId }) {
  return ensureSettings({ orgId });
}

async function updateSettings({ orgId, actorUserId, payload }) {
  const fields = [];
  const values = [orgId];
  const mapping = {
    enabled: 'enabled',
    defaultRateVersionId: 'default_rate_version_id',
    basisPeriodStartMonth: 'basis_period_start_month',
    basisPeriodEndMonth: 'basis_period_end_month',
    citPayableAccountId: 'cit_payable_account_id',
    citExpenseAccountId: 'cit_expense_account_id',
    taxCreditReceivableAccountId: 'tax_credit_receivable_account_id',
    graTaxOffice: 'gra_tax_office',
    taxpayerId: 'taxpayer_id',
    industryRateReviewed: 'industry_rate_reviewed',
    metadata: 'metadata',
  };
  for (const [key, column] of Object.entries(mapping)) {
    if (payload[key] === undefined) continue;
    values.push(key === 'metadata' ? JSON.stringify(payload[key] || {}) : payload[key]);
    fields.push(`${column}=$${values.length}${key === 'metadata' ? '::jsonb' : ''}`);
  }
  if (!fields.length) return getSettings({ orgId });
  await ensureSettings({ orgId });
  if (payload.defaultRateVersionId !== undefined && payload.industryRateReviewed === undefined) {
    fields.push(`industry_rate_reviewed=FALSE`);
  }
  values.push(actorUserId || null);
  const { rows } = await pool.query(
    `UPDATE ghana_cit_settings SET ${fields.join(',')},updated_by=$${values.length},updated_at=NOW() WHERE organization_id=$1 RETURNING *`,
    values,
  );
  return rows[0];
}

async function listRateVersions({ asOfDate = null } = {}) {
  const params = [];
  let where = `status='active'`;
  if (asOfDate) {
    assertDate(asOfDate, 'asOfDate');
    params.push(asOfDate);
    where += ` AND effective_from <= $1::date AND (effective_to IS NULL OR effective_to >= $1::date)`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM ghana_cit_rate_versions WHERE ${where} ORDER BY tax_rate,code,effective_from DESC`,
    params,
  );
  return rows;
}

async function resolveRateVersion({ client = pool, settings, rateVersionId = null, onDate }) {
  const id = rateVersionId || settings.default_rate_version_id;
  if (!id) throw new AppError(409, 'Select a Ghana CIT rate version first');
  const { rows } = await client.query(
    `SELECT * FROM ghana_cit_rate_versions WHERE id=$1 AND status='active' AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)`,
    [id, onDate],
  );
  if (!rows.length) throw new AppError(400, 'Selected CIT rate is not effective for the basis period');
  return rows[0];
}

async function accountingProfitFromLedger({ orgId, basisPeriodStart, basisPeriodEnd, client = pool }) {
  const { rows } = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN at.code='REVENUE' THEN (CASE WHEN jel.credit>0 THEN jel.amount_base ELSE -jel.amount_base END) ELSE 0 END),0)::numeric(18,2) AS revenue,
       COALESCE(SUM(CASE WHEN at.code='EXPENSE' THEN (CASE WHEN jel.debit>0 THEN jel.amount_base ELSE -jel.amount_base END) ELSE 0 END),0)::numeric(18,2) AS expenses
     FROM journal_entries je
     JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
     JOIN chart_of_accounts coa ON coa.id=jel.account_id AND coa.organization_id=je.organization_id
     JOIN account_types at ON at.id=coa.account_type_id
     WHERE je.organization_id=$1 AND je.status IN ('posted','voided')
       AND je.entry_date BETWEEN $2::date AND $3::date
       AND at.code IN ('REVENUE','EXPENSE')`,
    [orgId, basisPeriodStart, basisPeriodEnd],
  );
  const revenue = parseDecimalToBigInt(rows[0]?.revenue || '0', 2);
  const expenses = parseDecimalToBigInt(rows[0]?.expenses || '0', 2);
  return {
    revenue: bigIntToDecimalString(revenue, 2),
    expenses: bigIntToDecimalString(expenses, 2),
    accountingProfit: bigIntToDecimalString(revenue - expenses, 2),
  };
}

async function latestCapitalAllowance({ orgId, taxYear, client = pool }) {
  const { rows } = await client.query(
    `SELECT total_capital_allowance FROM ghana_capital_allowance_runs
      WHERE organization_id=$1 AND tax_year=$2 AND status='finalized'
      ORDER BY version_no DESC LIMIT 1`,
    [orgId, taxYear],
  );
  return rows[0]?.total_capital_allowance || '0.00';
}

async function withholdingCredits({ orgId, basisPeriodStart, basisPeriodEnd, client = pool }) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(withheld_amount),0)::numeric(18,2) AS amount
       FROM ghana_withholding_events
      WHERE organization_id=$1 AND regime='income_wht' AND direction='receivable'
        AND status<>'voided' AND event_date BETWEEN $2::date AND $3::date`,
    [orgId, basisPeriodStart, basisPeriodEnd],
  );
  return rows[0]?.amount || '0.00';
}

async function instalmentsPaidForYear({ orgId, taxYear, client = pool }) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_paid),0)::numeric(18,2) AS paid
       FROM (
         SELECT (x->>'quarter')::int AS quarter_no, MAX(COALESCE((x->>'amountPaid')::numeric,0)) AS amount_paid
           FROM ghana_cit_self_assessments s, jsonb_array_elements(s.instalments_json) x
          WHERE s.organization_id=$1 AND s.tax_year=$2 AND s.status IN ('finalized','filed')
          GROUP BY (x->>'quarter')::int
       ) q`,
    [orgId, taxYear],
  );
  return rows[0]?.paid || '0.00';
}

async function prepareComputation({ orgId, actorUserId, payload }) {
  assertDate(payload.basisPeriodStart, 'basisPeriodStart');
  assertDate(payload.basisPeriodEnd, 'basisPeriodEnd');
  if (payload.basisPeriodEnd < payload.basisPeriodStart) throw new AppError(400, 'basisPeriodEnd must be on or after basisPeriodStart');
  const taxYear = Number(payload.taxYear || String(payload.basisPeriodEnd).slice(0, 4));

  return withTransaction(async (client) => {
    const settings = await ensureSettings({ orgId, client });
    if (!settings.enabled) throw new AppError(409, 'Ghana CIT is not enabled for this organization');
    const rate = await resolveRateVersion({ client, settings, rateVersionId: payload.rateVersionId, onDate: payload.basisPeriodEnd });
    const ledger = await accountingProfitFromLedger({ orgId, basisPeriodStart: payload.basisPeriodStart, basisPeriodEnd: payload.basisPeriodEnd, client });
    const capitalAllowance = payload.capitalAllowance != null ? payload.capitalAllowance : await latestCapitalAllowance({ orgId, taxYear, client });
    const credits = payload.withholdingCredits != null ? payload.withholdingCredits : await withholdingCredits({ orgId, basisPeriodStart: payload.basisPeriodStart, basisPeriodEnd: payload.basisPeriodEnd, client });
    const instalments = payload.instalmentsPaid != null ? payload.instalmentsPaid : await instalmentsPaidForYear({ orgId, taxYear, client });

    const calc = calculateCitComputation({
      accountingProfit: payload.accountingProfit != null ? payload.accountingProfit : ledger.accountingProfit,
      addBacks: payload.addBacks || '0',
      otherAssessableIncome: payload.otherAssessableIncome || '0',
      allowableDeductions: payload.allowableDeductions || '0',
      capitalAllowance,
      lossRelief: payload.lossRelief || '0',
      taxRate: rate.tax_rate,
      withholdingCredits: credits,
      otherTaxCredits: payload.otherTaxCredits || '0',
      instalmentsPaid: instalments,
    });

    const { rows: vRows } = await client.query(
      `SELECT COALESCE(MAX(version_no),0)+1 AS version_no FROM ghana_cit_computations WHERE organization_id=$1 AND tax_year=$2`,
      [orgId, taxYear],
    );
    const versionNo = Number(vRows[0].version_no);
    const dueDate = annualReturnDueDate(payload.basisPeriodEnd);
    const snapshot = { ...calc, ledger, rateCode: rate.code, rateName: rate.name, generatedFromLedger: payload.accountingProfit == null, baseInputs: { accountingProfit: calc.accountingProfit, addBacks: money(payload.addBacks || '0'), otherAssessableIncome: money(payload.otherAssessableIncome || '0'), allowableDeductions: money(payload.allowableDeductions || '0'), capitalAllowance: money(capitalAllowance), lossRelief: money(payload.lossRelief || '0'), withholdingCredits: money(credits), otherTaxCredits: money(payload.otherTaxCredits || '0'), instalmentsPaid: money(instalments) } };
    const { rows } = await client.query(
      `INSERT INTO ghana_cit_computations(
        organization_id,tax_year,basis_period_start,basis_period_end,version_no,rate_version_id,
        accounting_profit,add_backs,other_assessable_income,allowable_deductions,adjusted_profit,
        capital_allowance,loss_relief,chargeable_income,tax_rate,gross_tax,withholding_credits,other_tax_credits,
        tax_after_credits,instalments_paid,net_tax_payable,overpayment,annual_return_due_date,calculation_snapshot,created_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25)
      RETURNING *`,
      [orgId,taxYear,payload.basisPeriodStart,payload.basisPeriodEnd,versionNo,rate.id,
       calc.accountingProfit,calc.addBacks,calc.otherAssessableIncome,calc.allowableDeductions,calc.adjustedProfit,
       calc.capitalAllowance,calc.lossRelief,calc.chargeableIncome,calc.taxRate,calc.grossTax,calc.withholdingCredits,calc.otherTaxCredits,
       calc.taxAfterCredits,calc.instalmentsPaid,calc.netTaxPayable,calc.overpayment,dueDate,JSON.stringify(snapshot),actorUserId || null],
    );
    return rows[0];
  });
}

async function listComputations({ orgId, query = {} }) {
  const params = [orgId];
  const where = ['c.organization_id=$1'];
  if (query.taxYear) { params.push(Number(query.taxYear)); where.push(`c.tax_year=$${params.length}`); }
  if (query.status) { params.push(query.status); where.push(`c.status=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT c.*,r.code AS rate_code,r.name AS rate_name FROM ghana_cit_computations c JOIN ghana_cit_rate_versions r ON r.id=c.rate_version_id WHERE ${where.join(' AND ')} ORDER BY c.tax_year DESC,c.version_no DESC`,
    params,
  );
  return rows;
}

async function getComputation({ orgId, id }) {
  const { rows } = await pool.query(
    `SELECT c.*,r.code AS rate_code,r.name AS rate_name,r.qualification_json FROM ghana_cit_computations c JOIN ghana_cit_rate_versions r ON r.id=c.rate_version_id WHERE c.organization_id=$1 AND c.id=$2`,
    [orgId, id],
  );
  if (!rows.length) throw new AppError(404, 'CIT computation not found');
  const { rows: adjustments } = await pool.query(`SELECT * FROM ghana_cit_adjustments WHERE organization_id=$1 AND computation_id=$2 ORDER BY created_at`, [orgId,id]);
  return { ...rows[0], adjustments };
}

function addMoneyStrings(...values) {
  return bigIntToDecimalString(values.reduce((sum,value)=>sum+parseDecimalToBigInt(value||'0',2),0n),2);
}

async function recalculateDraftComputation({ orgId, computationId, client = pool }) {
  const { rows } = await client.query(`SELECT * FROM ghana_cit_computations WHERE organization_id=$1 AND id=$2`,[orgId,computationId]);
  if(!rows.length) throw new AppError(404,'CIT computation not found');
  const c=rows[0];
  if(c.status!=='draft') throw new AppError(409,'Only draft CIT computations can be recalculated');
  const base=c.calculation_snapshot?.baseInputs || {
    accountingProfit:c.accounting_profit,addBacks:c.add_backs,otherAssessableIncome:c.other_assessable_income,
    allowableDeductions:c.allowable_deductions,capitalAllowance:c.capital_allowance,lossRelief:c.loss_relief,
    withholdingCredits:c.withholding_credits,otherTaxCredits:c.other_tax_credits,instalmentsPaid:c.instalments_paid,
  };
  const {rows:a}=await client.query(`SELECT adjustment_type,COALESCE(SUM(amount),0)::numeric(18,2) AS amount FROM ghana_cit_adjustments WHERE organization_id=$1 AND computation_id=$2 GROUP BY adjustment_type`,[orgId,computationId]);
  const sums=Object.fromEntries(a.map(x=>[x.adjustment_type,x.amount]));
  const calc=calculateCitComputation({
    accountingProfit:base.accountingProfit,
    addBacks:addMoneyStrings(base.addBacks,sums.add_back),
    otherAssessableIncome:addMoneyStrings(base.otherAssessableIncome,sums.other_income),
    allowableDeductions:addMoneyStrings(base.allowableDeductions,sums.deduction),
    capitalAllowance:base.capitalAllowance,
    lossRelief:addMoneyStrings(base.lossRelief,sums.loss_relief),
    taxRate:c.tax_rate,
    withholdingCredits:base.withholdingCredits,
    otherTaxCredits:addMoneyStrings(base.otherTaxCredits,sums.tax_credit),
    instalmentsPaid:base.instalmentsPaid,
  });
  const snapshot={...(c.calculation_snapshot||{}),...calc,lastRecalculatedAt:new Date().toISOString()};
  const {rows:out}=await client.query(`UPDATE ghana_cit_computations SET add_backs=$3,other_assessable_income=$4,allowable_deductions=$5,adjusted_profit=$6,loss_relief=$7,chargeable_income=$8,gross_tax=$9,other_tax_credits=$10,tax_after_credits=$11,net_tax_payable=$12,overpayment=$13,calculation_snapshot=$14::jsonb,updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,computationId,calc.addBacks,calc.otherAssessableIncome,calc.allowableDeductions,calc.adjustedProfit,calc.lossRelief,calc.chargeableIncome,calc.grossTax,calc.otherTaxCredits,calc.taxAfterCredits,calc.netTaxPayable,calc.overpayment,JSON.stringify(snapshot)]);
  return out[0];
}

async function addComputationAdjustment({ orgId, actorUserId, computationId, payload }) {
  const current = await getComputation({ orgId, id: computationId });
  if (current.status !== 'draft') throw new AppError(409, 'Only draft CIT computations can be adjusted');
  const allowed = new Set(['add_back','deduction','other_income','loss_relief','tax_credit','note']);
  if (!allowed.has(payload.adjustmentType)) throw new AppError(400, 'Invalid adjustmentType');
  if (!payload.description) throw new AppError(400, 'description is required');
  return withTransaction(async(client)=>{
    const { rows } = await client.query(
      `INSERT INTO ghana_cit_adjustments(organization_id,computation_id,adjustment_type,code,description,amount,source_account_id,legal_reference,metadata,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
      [orgId,computationId,payload.adjustmentType,payload.code || null,payload.description,money(payload.amount || '0'),payload.sourceAccountId || null,payload.legalReference || null,JSON.stringify(payload.metadata || {}),actorUserId || null],
    );
    const computation=await recalculateDraftComputation({orgId,computationId,client});
    return { adjustment:rows[0], computation };
  });
}

async function finalizeComputation({ orgId, actorUserId, id }) {
  return withTransaction(async (client) => {
    const settings = await ensureSettings({ orgId, client });
    if (!settings.taxpayer_id) throw new AppError(409, 'Ghana taxpayer ID/TIN is required before finalizing DT101');
    const { rows } = await client.query(`SELECT * FROM ghana_cit_computations WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId,id]);
    if (!rows.length) throw new AppError(404, 'CIT computation not found');
    if (rows[0].status !== 'draft') throw new AppError(409, 'Only draft CIT computations can be finalized');
    const { rows: rateRows } = await client.query(`SELECT code FROM ghana_cit_rate_versions WHERE id=$1`, [rows[0].rate_version_id]);
    if (rateRows[0]?.code !== 'GH_CIT_GENERAL' && !settings.industry_rate_reviewed) {
      throw new AppError(409, 'Review and confirm eligibility for the selected special CIT rate before finalization');
    }
    const { rows: out } = await client.query(
      `UPDATE ghana_cit_computations SET status='finalized',finalized_at=NOW(),finalized_by=$3,updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId,id,actorUserId || null],
    );
    return out[0];
  });
}

async function markComputationFiled({ orgId, actorUserId, id, graReference }) {
  if (!graReference) throw new AppError(400, 'graReference is required');
  const { rows } = await pool.query(
    `UPDATE ghana_cit_computations SET status='filed',gra_reference=$3,filed_at=NOW(),filed_by=$4,updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status='finalized' RETURNING *`,
    [orgId,id,graReference,actorUserId || null],
  );
  if (!rows.length) throw new AppError(409, 'Only finalized CIT computations can be marked filed');
  return rows[0];
}

async function createSelfAssessment({ orgId, actorUserId, payload }) {
  assertDate(payload.basisPeriodStart, 'basisPeriodStart');
  const taxYear = Number(payload.taxYear || String(payload.basisPeriodStart).slice(0,4));
  return withTransaction(async (client) => {
    const settings = await ensureSettings({ orgId, client });
    if (!settings.enabled) throw new AppError(409, 'Ghana CIT is not enabled');
    const rate = await resolveRateVersion({ client, settings, rateVersionId: payload.rateVersionId, onDate: payload.basisPeriodStart });
    const { rows: priorRows } = await client.query(`SELECT COALESCE(MAX(version_no),0) AS version FROM ghana_cit_self_assessments WHERE organization_id=$1 AND tax_year=$2`, [orgId,taxYear]);
    const versionNo = Number(priorRows[0].version) + 1;
    const formCode = versionNo === 1 ? 'DT102' : 'DT102A';
    if (versionNo > 1 && !payload.reasonsForRevision) throw new AppError(400, 'reasonsForRevision is required for DT102A');
    const calc = calculateSelfAssessment({ estimatedChargeableIncome: payload.estimatedChargeableIncome, taxRate: rate.tax_rate, taxCredits: payload.taxCredits || '0' });
    const dues = quarterlyInstalmentDueDates(payload.basisPeriodStart);
    const amounts = splitQuarterlyInstalments(calc.estimatedAnnualTax);
    const instalments = dues.map((dueDate,index) => ({ quarter:index+1,dueDate,amountDue:amounts[index],amountPaid:'0.00',paidDate:null,reference:null }));
    const { rows } = await client.query(
      `INSERT INTO ghana_cit_self_assessments(organization_id,tax_year,version_no,form_code,rate_version_id,estimated_chargeable_income,tax_rate,gross_estimated_tax,tax_credits,estimated_annual_tax,instalments_json,reasons_for_revision,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13) RETURNING *`,
      [orgId,taxYear,versionNo,formCode,rate.id,calc.estimatedChargeableIncome,calc.taxRate,calc.grossEstimatedTax,calc.taxCredits,calc.estimatedAnnualTax,JSON.stringify(instalments),payload.reasonsForRevision || null,actorUserId || null],
    );
    return rows[0];
  });
}

async function listSelfAssessments({ orgId, taxYear = null }) {
  const params=[orgId]; let extra='';
  if (taxYear) { params.push(Number(taxYear)); extra=` AND s.tax_year=$2`; }
  const { rows }=await pool.query(`SELECT s.*,r.code AS rate_code,r.name AS rate_name FROM ghana_cit_self_assessments s JOIN ghana_cit_rate_versions r ON r.id=s.rate_version_id WHERE s.organization_id=$1${extra} ORDER BY s.tax_year DESC,s.version_no DESC`,params);
  return rows;
}

async function finalizeSelfAssessment({ orgId, actorUserId, id }) {
  const settings=await ensureSettings({orgId});
  if (!settings.taxpayer_id) throw new AppError(409,'Ghana taxpayer ID/TIN is required');
  const {rows:sa}=await pool.query(`SELECT s.rate_version_id,r.code AS rate_code FROM ghana_cit_self_assessments s JOIN ghana_cit_rate_versions r ON r.id=s.rate_version_id WHERE s.organization_id=$1 AND s.id=$2`,[orgId,id]);
  if(!sa.length) throw new AppError(404,'Self-assessment not found');
  if(sa[0].rate_code!=='GH_CIT_GENERAL' && !settings.industry_rate_reviewed) throw new AppError(409,'Review and confirm eligibility for the selected special CIT rate before finalization');
  const { rows }=await pool.query(`UPDATE ghana_cit_self_assessments SET status='finalized',finalized_at=NOW(),finalized_by=$3,updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND status='draft' RETURNING *`,[orgId,id,actorUserId||null]);
  if (!rows.length) throw new AppError(409,'Only draft self-assessments can be finalized');
  return rows[0];
}

async function markSelfAssessmentFiled({ orgId, actorUserId, id, graReference }) {
  if (!graReference) throw new AppError(400,'graReference is required');
  const { rows }=await pool.query(`UPDATE ghana_cit_self_assessments SET status='filed',gra_reference=$3,filed_at=NOW(),filed_by=$4,updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND status='finalized' RETURNING *`,[orgId,id,graReference,actorUserId||null]);
  if (!rows.length) throw new AppError(409,'Only finalized self-assessments can be marked filed');
  return rows[0];
}

async function recordSelfAssessmentPayment({ orgId, id, payload }) {
  const quarter=asPositiveInt(payload.quarter,'quarter');
  if (quarter>4) throw new AppError(400,'quarter must be between 1 and 4');
  assertDate(payload.paidDate,'paidDate');
  return withTransaction(async(client)=>{
    const { rows }=await client.query(`SELECT * FROM ghana_cit_self_assessments WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[orgId,id]);
    if(!rows.length) throw new AppError(404,'Self-assessment not found');
    if(!['finalized','filed'].includes(rows[0].status)) throw new AppError(409,'Finalize the self-assessment before recording instalment payments');
    const instalments=Array.isArray(rows[0].instalments_json)?rows[0].instalments_json:[];
    const idx=instalments.findIndex(x=>Number(x.quarter)===quarter);
    if(idx<0) throw new AppError(404,'Quarter instalment not found');
    instalments[idx]={...instalments[idx],amountPaid:money(payload.amountPaid),paidDate:payload.paidDate,reference:payload.reference||null};
    const {rows:out}=await client.query(`UPDATE ghana_cit_self_assessments SET instalments_json=$3::jsonb,updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,id,JSON.stringify(instalments)]);
    return out[0];
  });
}

async function listTaxAssetClasses() {
  const { rows } = await pool.query(`SELECT * FROM ghana_tax_asset_classes WHERE status='active' ORDER BY code`);
  return rows;
}

async function listTaxAssets({ orgId, query = {} }) {
  const params=[orgId]; const where=['a.organization_id=$1'];
  if(query.status){params.push(query.status);where.push(`a.status=$${params.length}`);}
  if(query.assetClassId){params.push(query.assetClassId);where.push(`a.asset_class_id=$${params.length}`);}
  const { rows }=await pool.query(`SELECT a.*,c.code AS class_code,c.name AS class_name,c.method,c.rate FROM ghana_tax_assets a JOIN ghana_tax_asset_classes c ON c.id=a.asset_class_id WHERE ${where.join(' AND ')} ORDER BY a.tax_asset_code`,params);
  return rows;
}

async function createTaxAsset({ orgId, actorUserId, payload }) {
  if(!payload.assetClassId) throw new AppError(400,'assetClassId is required');
  if(!payload.taxAssetCode || !payload.description) throw new AppError(400,'taxAssetCode and description are required');
  assertDate(payload.firstUseDate,'firstUseDate');
  const {rows:cls}=await pool.query(`SELECT * FROM ghana_tax_asset_classes WHERE id=$1 AND status='active'`,[payload.assetClassId]);
  if(!cls.length) throw new AppError(400,'Invalid Ghana tax asset class');
  if(cls[0].useful_life_required && !payload.usefulLifeYears) throw new AppError(400,'usefulLifeYears is required for this tax asset class');
  const {rows}=await pool.query(`INSERT INTO ghana_tax_assets(organization_id,fixed_asset_id,asset_class_id,tax_asset_code,description,first_use_date,tax_cost,business_use_percent,useful_life_years,metadata,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *`,[orgId,payload.fixedAssetId||null,payload.assetClassId,payload.taxAssetCode,payload.description,payload.firstUseDate,money(payload.taxCost),payload.businessUsePercent==null?100:payload.businessUsePercent,payload.usefulLifeYears||null,JSON.stringify(payload.metadata||{}),actorUserId||null]);
  return rows[0];
}

async function disposeTaxAsset({ orgId, id, payload }) {
  assertDate(payload.disposalDate,'disposalDate');
  const {rows}=await pool.query(`UPDATE ghana_tax_assets SET status='disposed',disposal_date=$3,disposal_proceeds=$4,updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND status='active' RETURNING *`,[orgId,id,payload.disposalDate,money(payload.disposalProceeds||'0')]);
  if(!rows.length) throw new AppError(409,'Only active tax assets can be disposed');
  return rows[0];
}

async function previousAssetClosingWdv({ orgId, taxAssetId, beforeTaxYear, client }) {
  const {rows}=await client.query(`SELECT l.closing_wdv FROM ghana_capital_allowance_run_lines l JOIN ghana_capital_allowance_runs r ON r.id=l.run_id WHERE l.organization_id=$1 AND l.tax_asset_id=$2 AND r.status='finalized' AND r.tax_year<$3 ORDER BY r.tax_year DESC,r.version_no DESC LIMIT 1`,[orgId,taxAssetId,beforeTaxYear]);
  return rows[0]?.closing_wdv || null;
}

function daysInclusive(start,end){
  const a=new Date(`${start}T00:00:00Z`); const b=new Date(`${end}T00:00:00Z`);
  return Math.max(1,Math.round((b-a)/86400000)+1);
}

async function prepareCapitalAllowanceRun({ orgId, actorUserId, payload }) {
  assertDate(payload.basisPeriodStart,'basisPeriodStart'); assertDate(payload.basisPeriodEnd,'basisPeriodEnd');
  const taxYear=Number(payload.taxYear||String(payload.basisPeriodEnd).slice(0,4));
  return withTransaction(async(client)=>{
    const {rows:assets}=await client.query(`SELECT a.*,c.code AS class_code,c.name AS class_name,c.method,c.rate,c.useful_life_required FROM ghana_tax_assets a JOIN ghana_tax_asset_classes c ON c.id=a.asset_class_id WHERE a.organization_id=$1 AND a.first_use_date <= $2::date AND (a.disposal_date IS NULL OR a.disposal_date >= $3::date) AND a.status<>'inactive' ORDER BY c.code,a.tax_asset_code`,[orgId,payload.basisPeriodEnd,payload.basisPeriodStart]);
    const {rows:v}=await client.query(`SELECT COALESCE(MAX(version_no),0)+1 AS version FROM ghana_capital_allowance_runs WHERE organization_id=$1 AND tax_year=$2`,[orgId,taxYear]);
    const versionNo=Number(v[0].version);
    const {rows:runRows}=await client.query(`INSERT INTO ghana_capital_allowance_runs(organization_id,tax_year,basis_period_start,basis_period_end,version_no,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[orgId,taxYear,payload.basisPeriodStart,payload.basisPeriodEnd,versionNo,actorUserId||null]);
    const run=runRows[0];
    let openingTotal=0n,additionsTotal=0n,disposalsTotal=0n,allowanceTotal=0n,closingTotal=0n;
    for(const asset of assets){
      const prior=await previousAssetClosingWdv({orgId,taxAssetId:asset.id,beforeTaxYear:taxYear,client});
      const firstUseInPeriod=String(asset.first_use_date)>=payload.basisPeriodStart && String(asset.first_use_date)<=payload.basisPeriodEnd;
      const opening=prior||'0.00';
      const additions=firstUseInPeriod?money(asset.tax_cost):'0.00';
      const disposedInPeriod=asset.disposal_date && String(asset.disposal_date)>=payload.basisPeriodStart && String(asset.disposal_date)<=payload.basisPeriodEnd;
      const disposals=disposedInPeriod?money(asset.disposal_proceeds||'0'):'0.00';
      const days=daysInclusive(firstUseInPeriod?String(asset.first_use_date):payload.basisPeriodStart,disposedInPeriod?String(asset.disposal_date):payload.basisPeriodEnd);
      const businessPctUnits=parseDecimalToBigInt(String(asset.business_use_percent||'100'),6);
      const businessPctDenominator=100n*(10n**6n);
      const adjustedOpening=bigIntToDecimalString(divideAndRoundHalfUp(parseDecimalToBigInt(opening,2)*businessPctUnits,businessPctDenominator),2);
      const adjustedAdditions=bigIntToDecimalString(divideAndRoundHalfUp(parseDecimalToBigInt(additions,2)*businessPctUnits,businessPctDenominator),2);
      const adjustedDisposals=bigIntToDecimalString(divideAndRoundHalfUp(parseDecimalToBigInt(disposals,2)*businessPctUnits,businessPctDenominator),2);
      const adjustedOriginalCost=bigIntToDecimalString(divideAndRoundHalfUp(parseDecimalToBigInt(asset.tax_cost,2)*businessPctUnits,businessPctDenominator),2);
      const calc=calculateCapitalAllowance({openingTaxWdv:adjustedOpening,additions:adjustedAdditions,disposals:adjustedDisposals,rate:asset.rate||'0',usefulLifeYears:asset.useful_life_years,straightLineCostBasis:adjustedOriginalCost,daysInBasisPeriod:days,method:asset.method});
      await client.query(`INSERT INTO ghana_capital_allowance_run_lines(organization_id,run_id,tax_asset_id,asset_class_id,asset_code,description,opening_wdv,additions,disposals,rate,method,days_in_basis_period,capital_allowance,closing_wdv,calculation_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,[orgId,run.id,asset.id,asset.asset_class_id,asset.tax_asset_code,asset.description,calc.openingTaxWdv,calc.additions,calc.disposals,asset.rate||null,asset.method,days,calc.capitalAllowance,calc.closingTaxWdv,JSON.stringify({...calc,businessUsePercent:String(asset.business_use_percent),classCode:asset.class_code})]);
      openingTotal+=parseDecimalToBigInt(calc.openingTaxWdv,2); additionsTotal+=parseDecimalToBigInt(calc.additions,2); disposalsTotal+=parseDecimalToBigInt(calc.disposals,2); allowanceTotal+=parseDecimalToBigInt(calc.capitalAllowance,2); closingTotal+=parseDecimalToBigInt(calc.closingTaxWdv,2);
    }
    const {rows:out}=await client.query(`UPDATE ghana_capital_allowance_runs SET total_opening_wdv=$3,total_additions=$4,total_disposals=$5,total_capital_allowance=$6,total_closing_wdv=$7,updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,run.id,bigIntToDecimalString(openingTotal,2),bigIntToDecimalString(additionsTotal,2),bigIntToDecimalString(disposalsTotal,2),bigIntToDecimalString(allowanceTotal,2),bigIntToDecimalString(closingTotal,2)]);
    return out[0];
  });
}

async function listCapitalAllowanceRuns({orgId,taxYear=null}){
  const params=[orgId];let extra=''; if(taxYear){params.push(Number(taxYear));extra=' AND tax_year=$2';}
  const {rows}=await pool.query(`SELECT * FROM ghana_capital_allowance_runs WHERE organization_id=$1${extra} ORDER BY tax_year DESC,version_no DESC`,params);return rows;
}

async function getCapitalAllowanceRun({orgId,id}){
  const {rows}=await pool.query(`SELECT * FROM ghana_capital_allowance_runs WHERE organization_id=$1 AND id=$2`,[orgId,id]);if(!rows.length)throw new AppError(404,'Capital allowance run not found');
  const {rows:lines}=await pool.query(`SELECT l.*,c.code AS class_code,c.name AS class_name FROM ghana_capital_allowance_run_lines l JOIN ghana_tax_asset_classes c ON c.id=l.asset_class_id WHERE l.organization_id=$1 AND l.run_id=$2 ORDER BY c.code,l.asset_code`,[orgId,id]);return {...rows[0],lines};
}

async function finalizeCapitalAllowanceRun({orgId,actorUserId,id}){
  const {rows}=await pool.query(`UPDATE ghana_capital_allowance_runs SET status='finalized',finalized_at=NOW(),finalized_by=$3,updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND status='draft' RETURNING *`,[orgId,id,actorUserId||null]);if(!rows.length)throw new AppError(409,'Only draft capital allowance runs can be finalized');return rows[0];
}

async function listIndustryProfiles({orgId}){
  const {rows}=await pool.query(`SELECT p.*, (o.organization_id IS NOT NULL) AS installed, o.settings_json,o.reviewed_at FROM ghana_industry_profiles p LEFT JOIN organization_industry_profiles o ON o.industry_profile_id=p.id AND o.organization_id=$1 WHERE p.status='active' ORDER BY p.name`,[orgId]);return rows;
}

async function installIndustryProfile({orgId,actorUserId,profileCode,settings={}}){
  const {rows:p}=await pool.query(`SELECT * FROM ghana_industry_profiles WHERE code=$1 AND status='active'`,[profileCode]);if(!p.length)throw new AppError(404,'Industry profile not found');
  const {rows}=await pool.query(`INSERT INTO organization_industry_profiles(organization_id,industry_profile_id,installed_by,settings_json) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(organization_id) DO UPDATE SET industry_profile_id=EXCLUDED.industry_profile_id,installed_at=NOW(),installed_by=EXCLUDED.installed_by,settings_json=EXCLUDED.settings_json,reviewed_at=NULL,reviewed_by=NULL RETURNING *`,[orgId,p[0].id,actorUserId||null,JSON.stringify(settings||{})]);return {...rows[0],profile:p[0]};
}

async function reviewIndustryProfile({orgId,actorUserId,settings={}}){
  const {rows}=await pool.query(`UPDATE organization_industry_profiles SET settings_json=COALESCE($3::jsonb,settings_json),reviewed_at=NOW(),reviewed_by=$2 WHERE organization_id=$1 RETURNING *`,[orgId,actorUserId||null,JSON.stringify(settings||{})]);if(!rows.length)throw new AppError(404,'No Ghana industry profile installed');return rows[0];
}

function readinessStatus(score, blockers, warnings){
  if(blockers.length) return score>=70?'in_progress':'not_ready';
  if(warnings.length) return 'ready_with_warnings';
  return score>=90?'ready':'in_progress';
}

async function getReadiness({orgId,actorUserId=null,persist=false}){
  const checks=[];const blockers=[];const warnings=[];
  const add=(code,label,ok,weight,severity='warning',detail=null)=>{checks.push({code,label,ok,weight,severity,detail});if(!ok){(severity==='blocker'?blockers:warnings).push({code,label,detail});}};

  const {rows:pack}=await pool.query(`SELECT 1 FROM tax_country_pack_installs i JOIN tax_country_packs p ON p.id=i.pack_id WHERE i.organization_id=$1 AND p.country_code='GH' LIMIT 1`,[orgId]);
  add('ghana_pack','Ghana tax country pack installed',Boolean(pack.length),8,'blocker');
  const cit=await ensureSettings({orgId});
  add('taxpayer_id','Ghana taxpayer identifier configured',Boolean(cit.taxpayer_id),8,'blocker');
  add('cit_enabled','Ghana CIT enabled',cit.enabled===true,6,'warning');
  add('cit_rate','CIT rate selected and reviewed',Boolean(cit.default_rate_version_id) && (cit.rate_code==='GH_CIT_GENERAL'||cit.industry_rate_reviewed===true),6,'blocker');
  add('cit_accounts','CIT GL accounts mapped',Boolean(cit.cit_payable_account_id&&cit.cit_expense_account_id),5,'warning');

  const {rows:vat}=await pool.query(`SELECT COUNT(*)::int AS n FROM tax_registrations WHERE organization_id=$1 AND registration_type='VAT' AND (effective_to IS NULL OR effective_to>=CURRENT_DATE)`,[orgId]);
  add('vat_registration','VAT registration reviewed/configured',Number(vat[0]?.n||0)>0,7,'warning','Not every organization must be VAT registered; confirm the organization\'s legal position.');
  const {rows:catalog}=await pool.query(`SELECT COUNT(*)::int AS active_items,COUNT(*) FILTER(WHERE tax_profile_id IS NULL)::int AS unclassified FROM inventory_items WHERE organization_id=$1 AND status='active'`,[orgId]);
  const activeItems=Number(catalog[0]?.active_items||0),unclassified=Number(catalog[0]?.unclassified||0);
  add('catalog_classification','Active inventory tax classification complete',activeItems===0||unclassified===0,10,unclassified>0?'blocker':'warning',unclassified?`${unclassified} active items have no tax profile`:null);

  const {rows:wht}=await pool.query(`SELECT gh_income_wht_agent_enabled,gh_vat_withholding_agent_enabled FROM tax_settings WHERE organization_id=$1`,[orgId]);
  add('withholding_review','Income WHT / WHVAT status reviewed',Boolean(wht.length),5,'warning');
  const {rows:pay}=await pool.query(`SELECT enabled,employer_tax_id,ssnit_employer_number,paye_payable_account_id,ssnit_tier1_payable_account_id,tier2_payable_account_id FROM ghana_payroll_settings WHERE organization_id=$1`,[orgId]);
  const payOk=!pay.length||pay[0].enabled!==true||Boolean(pay[0].employer_tax_id&&pay[0].paye_payable_account_id);
  add('ghana_payroll','Ghana payroll statutory configuration complete when enabled',payOk,8,payOk?'warning':'blocker');

  const {rows:fiscal}=await pool.query(`SELECT enabled,onboarding_status,adapter_mode FROM fiscalization_settings WHERE organization_id=$1`,[orgId]);
  const fiscalEnabled=fiscal[0]?.enabled===true;
  const fiscalReady=!fiscalEnabled||fiscal[0]?.adapter_mode==='simulation'||['signed_off','live'].includes(fiscal[0]?.onboarding_status);
  add('evat','E-VAT fiscalization readiness reviewed',fiscalReady,8,fiscalEnabled&&!fiscalReady?'blocker':'warning',fiscalEnabled?`mode=${fiscal[0]?.adapter_mode}, onboarding=${fiscal[0]?.onboarding_status}`:'E-VAT disabled');

  const {rows:assets}=await pool.query(`SELECT COUNT(*)::int AS fixed_count FROM fixed_assets WHERE organization_id=$1 AND status IN ('active','retired')`,[orgId]);
  const {rows:taxAssets}=await pool.query(`SELECT COUNT(*)::int AS tax_count FROM ghana_tax_assets WHERE organization_id=$1 AND status<>'inactive'`,[orgId]);
  const fixedCount=Number(assets[0]?.fixed_count||0),taxCount=Number(taxAssets[0]?.tax_count||0);
  add('tax_assets','Tax capital-allowance register reviewed',fixedCount===0||taxCount>=fixedCount,8,fixedCount>taxCount?'warning':'warning',fixedCount>taxCount?`${fixedCount-taxCount} fixed assets are not linked to a Ghana tax asset`:null);

  const {rows:industry}=await pool.query(`SELECT p.code,p.name,o.reviewed_at FROM organization_industry_profiles o JOIN ghana_industry_profiles p ON p.id=o.industry_profile_id WHERE o.organization_id=$1`,[orgId]);
  add('industry_profile','Ghana industry profile installed and reviewed',Boolean(industry.length&&industry[0].reviewed_at),7,'warning',industry.length?industry[0].name:'No industry profile installed');

  const {rows:dead}=await pool.query(`SELECT COUNT(*)::int AS n FROM fiscal_transmission_queue WHERE organization_id=$1 AND status='dead_letter'`,[orgId]);
  add('fiscal_dead_letters','No unresolved fiscalization dead letters',Number(dead[0]?.n||0)===0,6,Number(dead[0]?.n||0)>0?'blocker':'warning',Number(dead[0]?.n||0)>0?`${dead[0].n} dead-letter fiscal transmissions`:null);

  const totalWeight=checks.reduce((s,c)=>s+c.weight,0);const earned=checks.reduce((s,c)=>s+(c.ok?c.weight:0),0);const score=totalWeight?Math.round((earned/totalWeight)*10000)/100:0;const status=readinessStatus(score,blockers,warnings);
  const result={score,status,checks,blockers,warnings,industryProfile:industry[0]||null,generatedAt:new Date().toISOString()};
  if(persist){await pool.query(`INSERT INTO ghana_readiness_snapshots(organization_id,score,status,checks_json,blockers_json,warnings_json,generated_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)`,[orgId,score,status,JSON.stringify(checks),JSON.stringify(blockers),JSON.stringify(warnings),actorUserId||null]);}
  return result;
}

module.exports={
  getSettings,updateSettings,listRateVersions,
  prepareComputation,listComputations,getComputation,addComputationAdjustment,finalizeComputation,markComputationFiled,
  createSelfAssessment,listSelfAssessments,finalizeSelfAssessment,markSelfAssessmentFiled,recordSelfAssessmentPayment,
  listTaxAssetClasses,listTaxAssets,createTaxAsset,disposeTaxAsset,prepareCapitalAllowanceRun,listCapitalAllowanceRuns,getCapitalAllowanceRun,finalizeCapitalAllowanceRun,
  listIndustryProfiles,installIndustryProfile,reviewIndustryProfile,getReadiness,
};
