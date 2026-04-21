
const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const { findOpenPeriodForDate } = require("../../interfaces/periodManagement.interface");
const Decimal = require('decimal.js');
const workflow = require('./ifrs16.helpers');

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -10, toExpPos: 20 });

function toDecimal(value, defaultValue = new Decimal(0)) {
  if (value instanceof Decimal) return value;
  if (value === null || value === undefined || value === '') return defaultValue;
  try { return new Decimal(value); } catch { return defaultValue; }
}
function roundCurrency(value, decimals = 2) { return toDecimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_EVEN); }
function toCurrencyNumber(value, decimals = 2) { return roundCurrency(value, decimals).toNumber(); }
function toISODate(d) { return workflow.toISODate(d); }
function buildIfrs16IdempotencyKey(parts) { return workflow.buildIfrs16IdempotencyKey(parts); }

function calculatePresentValue({ payment, annualDiscountRate, periods, paymentsPerYear = 12, paymentTiming = 'arrears' }) {
  const PMT = toDecimal(payment); const ppy = toDecimal(paymentsPerYear); const r = toDecimal(annualDiscountRate).div(ppy); const n = toDecimal(periods);
  if (r.equals(0)) return PMT.times(n);
  const onePlusR = new Decimal(1).plus(r); const power = onePlusR.pow(n.negated());
  const pvOrdinary = PMT.times(new Decimal(1).minus(power)).div(r);
  return paymentTiming === 'advance' ? pvOrdinary.times(onePlusR) : pvOrdinary;
}
function addMonths(date, months) { const d = new Date(date); const day = d.getUTCDate(); d.setUTCMonth(d.getUTCMonth() + months); if (d.getUTCDate() < day) d.setUTCDate(0); return d; }
function assertLeaseStatusAllowed(lease, allowed, action) { if (!allowed.includes(lease.status)) throw new AppError(409, `${action} is not allowed when lease status is '${lease.status}'`); }

async function recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId, modificationId, action, idempotencyKey, journalEntryId }) {
  await client.query(`INSERT INTO lease_posting_ledger(organization_id,lease_id,schedule_line_id,modification_id,action,idempotency_key,journal_entry_id,created_by)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                      ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    [orgId, leaseId, scheduleLineId || null, modificationId || null, action, idempotencyKey, journalEntryId, actorUserId]);
}
async function recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType, payload = {} }) {
  await client.query(`INSERT INTO lease_events(organization_id, lease_id, event_type, event_payload, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [orgId, leaseId, eventType, payload, actorUserId]);
}
async function assertPostableAccount({ orgId, accountId, label, client = pool }) {
  const { rows } = await client.query(`SELECT id, status, is_postable FROM chart_of_accounts WHERE organization_id=$1 AND id=$2 LIMIT 1`, [orgId, accountId]);
  if (!rows.length) throw new AppError(400, `Invalid ${label}`);
  if (rows[0].status !== 'active') throw new AppError(400, `${label} must be an active account`);
  if (!rows[0].is_postable) throw new AppError(400, `${label} must be postable`);
}
async function getLeaseBase({ orgId, leaseId, client = pool }) {
  const { rows } = await client.query(`SELECT l.*,
      coa_cash.name AS cash_account_name,
      coa_rou.name AS rou_asset_account_name,
      coa_ll.name AS lease_liability_account_name,
      coa_ad.name AS accumulated_depreciation_account_name,
      coa_de.name AS depreciation_expense_account_name,
      coa_ie.name AS interest_expense_account_name
    FROM leases l
    LEFT JOIN chart_of_accounts coa_cash ON coa_cash.id = l.cash_account_id
    LEFT JOIN chart_of_accounts coa_rou ON coa_rou.id = l.rou_asset_account_id
    LEFT JOIN chart_of_accounts coa_ll ON coa_ll.id = l.lease_liability_account_id
    LEFT JOIN chart_of_accounts coa_ad ON coa_ad.id = l.accumulated_depreciation_account_id
    LEFT JOIN chart_of_accounts coa_de ON coa_de.id = l.depreciation_expense_account_id
    LEFT JOIN chart_of_accounts coa_ie ON coa_ie.id = l.interest_expense_account_id
    WHERE l.id=$1 AND l.organization_id=$2 LIMIT 1`, [leaseId, orgId]);
  if (!rows.length) throw new AppError(404, 'Lease not found');
  return rows[0];
}
async function getLeaseSnapshot({ orgId, leaseId, client = pool }) {
  const lease = await getLeaseBase({ orgId, leaseId, client });
  const [contractRows, assetRows, paymentRows, modRows, schedRows] = await Promise.all([
    client.query(`SELECT * FROM lease_contracts WHERE lease_id=$1 AND organization_id=$2 LIMIT 1`, [leaseId, orgId]),
    client.query(`SELECT * FROM lease_assets WHERE lease_id=$1 AND organization_id=$2 ORDER BY is_primary DESC, created_at ASC`, [leaseId, orgId]),
    client.query(`SELECT * FROM lease_payments WHERE lease_id=$1 AND organization_id=$2 ORDER BY due_date ASC, created_at ASC`, [leaseId, orgId]),
    client.query(`SELECT * FROM lease_modifications WHERE lease_id=$1 AND organization_id=$2 ORDER BY effective_date DESC, created_at DESC`, [leaseId, orgId]),
    client.query(`SELECT * FROM lease_schedule_lines WHERE lease_id=$1 ORDER BY line_no ASC`, [leaseId]),
  ]);
  return { lease, contract: contractRows.rows[0] || null, assets: assetRows.rows, payments: paymentRows.rows, modifications: modRows.rows, schedule: schedRows.rows };
}

async function listLeases({ orgId, query }) {
  const limit = Math.min(Number(query?.limit || 50), 200); const offset = Math.max(Number(query?.offset || 0), 0);
  const status = query?.status; const where = ['organization_id=$1']; const params = [orgId];
  if (status) { params.push(status); where.push(`status=$${params.length}`); }
  const { rows } = await pool.query(`SELECT id, code, name, status, commencement_date, term_months,payment_amount, payments_per_year, annual_discount_rate,payment_timing,
      workflow_document_id, submitted_at, approved_at,
      initial_recognition_date, initial_recognition_journal_id, created_at, updated_at
    FROM leases WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
    [...params, limit, offset]);
  return { items: rows, limit, offset };
}

async function createLease({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [field, label] of [
      [payload.rou_asset_account_id,'rou_asset_account_id'], [payload.lease_liability_account_id,'lease_liability_account_id'],
      [payload.interest_expense_account_id,'interest_expense_account_id'], [payload.depreciation_expense_account_id,'depreciation_expense_account_id'],
      [payload.accumulated_depreciation_account_id,'accumulated_depreciation_account_id'], [payload.cash_account_id,'cash_account_id']
    ]) await assertPostableAccount({ orgId, accountId: field, label, client });

    const { rows: existing } = await client.query(`SELECT 1 FROM leases WHERE organization_id=$1 AND code=$2 LIMIT 1`, [orgId, payload.code]);
    if (existing.length) throw new AppError(409, 'Lease code already exists');

    const paymentAmount = toDecimal(payload.payment_amount); const annualDiscountRate = toDecimal(payload.annual_discount_rate); const termMonths = toDecimal(payload.term_months);
    if (!paymentAmount.greaterThan(0)) throw new AppError(400, 'Payment amount must be greater than 0');
    if (!annualDiscountRate.greaterThanOrEqualTo(0)) throw new AppError(400, 'Annual discount rate must be non-negative');
    if (!termMonths.greaterThan(0)) throw new AppError(400, 'Term months must be greater than 0');

    const { rows } = await client.query(`INSERT INTO leases(organization_id,code,name,status,commencement_date,term_months,payment_amount,payments_per_year,annual_discount_rate,payment_timing,
      rou_asset_account_id,lease_liability_account_id,interest_expense_account_id,depreciation_expense_account_id,accumulated_depreciation_account_id,cash_account_id,created_by)
      VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [orgId,payload.code,payload.name,toISODate(payload.commencement_date),termMonths.toNumber(),paymentAmount.toNumber(),payload.payments_per_year,annualDiscountRate.toNumber(),payload.payment_timing,
        payload.rou_asset_account_id,payload.lease_liability_account_id,payload.interest_expense_account_id,payload.depreciation_expense_account_id,payload.accumulated_depreciation_account_id,payload.cash_account_id,actorUserId]);
    const lease = rows[0];

    await client.query(`INSERT INTO lease_contracts(lease_id,organization_id,contract_reference,currency_code,payment_timing,initial_direct_costs,lease_incentives,restoration_provision)
                        VALUES($1,$2,$3,COALESCE($4,'USD'),$5,$6,$7,$8)
                        ON CONFLICT (lease_id) DO UPDATE SET updated_at=NOW()`,
      [lease.id, orgId, payload.contract_reference || payload.code, payload.currency_code || 'USD', payload.payment_timing, payload.initial_direct_costs || null, payload.lease_incentives || null, payload.restoration_provision || null]);
    await client.query(`INSERT INTO lease_assets(lease_id,organization_id,asset_code,description,asset_class,useful_life_months,rou_cost,is_primary)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)`,
      [lease.id, orgId, payload.asset_code || payload.code, payload.asset_description || payload.name, payload.asset_class || null, payload.useful_life_months || termMonths.toNumber(), null]);

    await recordLeaseEvent({ client, orgId, actorUserId, leaseId: lease.id, eventType: 'LEASE_CREATED', payload: { code: lease.code, commencement_date: lease.commencement_date } });
    await client.query('COMMIT');
    return lease;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

async function getLease({ orgId, leaseId }) { return getLeaseSnapshot({ orgId, leaseId, client: pool }); }

async function upsertContract({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getLeaseBase({ orgId, leaseId, client });
    const { rows } = await client.query(`INSERT INTO lease_contracts(
        lease_id, organization_id, counterparty_partner_id, contract_reference, currency_code, payment_timing, indexation,
        has_purchase_option, has_extension_option, has_termination_option, residual_value_guarantee, initial_direct_costs, lease_incentives, restoration_provision)
      VALUES ($1,$2,$3,$4,COALESCE($5,'USD'),COALESCE($6,'arrears'),$7,COALESCE($8,FALSE),COALESCE($9,FALSE),COALESCE($10,FALSE),$11,$12,$13,$14)
      ON CONFLICT (lease_id) DO UPDATE SET
        counterparty_partner_id=EXCLUDED.counterparty_partner_id, contract_reference=EXCLUDED.contract_reference, currency_code=EXCLUDED.currency_code,
        payment_timing=EXCLUDED.payment_timing, indexation=EXCLUDED.indexation, has_purchase_option=EXCLUDED.has_purchase_option,
        has_extension_option=EXCLUDED.has_extension_option, has_termination_option=EXCLUDED.has_termination_option, residual_value_guarantee=EXCLUDED.residual_value_guarantee,
        initial_direct_costs=EXCLUDED.initial_direct_costs, lease_incentives=EXCLUDED.lease_incentives, restoration_provision=EXCLUDED.restoration_provision,
        updated_at=NOW() RETURNING *`,
      [leaseId, orgId, payload.counterparty_partner_id || null, payload.contract_reference || null, payload.currency_code || 'USD', payload.payment_timing || 'arrears', payload.indexation || null,
       payload.has_purchase_option ?? false, payload.has_extension_option ?? false, payload.has_termination_option ?? false, payload.residual_value_guarantee || null,
       payload.initial_direct_costs || null, payload.lease_incentives || null, payload.restoration_provision || null]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType: 'CONTRACT_UPSERTED', payload: rows[0] });
    await client.query('COMMIT');
    return rows[0];
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
async function listAssets({ orgId, leaseId }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_assets WHERE organization_id=$1 AND lease_id=$2 ORDER BY is_primary DESC, created_at ASC`, [orgId, leaseId]); return { items: rows }; }
async function createAsset({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect(); try { await client.query('BEGIN'); await getLeaseBase({ orgId, leaseId, client });
    if (payload.is_primary) await client.query(`UPDATE lease_assets SET is_primary=FALSE, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2`, [orgId, leaseId]);
    const { rows } = await client.query(`INSERT INTO lease_assets(lease_id,organization_id,asset_code,description,asset_class,useful_life_months,rou_cost,is_primary)
      VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,FALSE)) RETURNING *`, [leaseId,orgId,payload.asset_code || null,payload.description,payload.asset_class || null,payload.useful_life_months || null,payload.rou_cost || null,payload.is_primary ?? false]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'ASSET_CREATED', payload: rows[0] }); await client.query('COMMIT'); return rows[0];
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function updateAsset({ orgId, actorUserId, leaseId, assetId, payload }) {
  const client = await pool.connect(); try { await client.query('BEGIN'); await getLeaseBase({ orgId, leaseId, client }); if (payload.is_primary) await client.query(`UPDATE lease_assets SET is_primary=FALSE, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2`, [orgId, leaseId]);
    const { rows } = await client.query(`UPDATE lease_assets SET asset_code=COALESCE($4,asset_code), description=COALESCE($5,description), asset_class=COALESCE($6,asset_class), useful_life_months=COALESCE($7,useful_life_months), rou_cost=COALESCE($8,rou_cost), is_primary=COALESCE($9,is_primary), updated_at=NOW()
      WHERE organization_id=$1 AND lease_id=$2 AND id=$3 RETURNING *`, [orgId, leaseId, assetId, payload.asset_code ?? null, payload.description ?? null, payload.asset_class ?? null, payload.useful_life_months ?? null, payload.rou_cost ?? null, payload.is_primary ?? null]);
    if (!rows.length) throw new AppError(404,'Lease asset not found'); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'ASSET_UPDATED', payload: rows[0] }); await client.query('COMMIT'); return rows[0];
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function deleteAsset({ orgId, actorUserId, leaseId, assetId }) { const client = await pool.connect(); try { await client.query('BEGIN'); const { rows } = await client.query(`DELETE FROM lease_assets WHERE organization_id=$1 AND lease_id=$2 AND id=$3 RETURNING *`, [orgId, leaseId, assetId]); if (!rows.length) throw new AppError(404,'Lease asset not found'); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'ASSET_DELETED', payload:{ asset_id: assetId } }); await client.query('COMMIT'); return { deleted: true }; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }

async function listPayments({ orgId, leaseId, query }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_payments WHERE organization_id=$1 AND lease_id=$2 ORDER BY due_date ASC, created_at ASC`, [orgId, leaseId]); return { items: rows }; }
async function createPayment({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect(); try { await client.query('BEGIN'); await getLeaseBase({ orgId, leaseId, client });
    let scheduleLineId = payload.schedule_line_id || null;
    if (!scheduleLineId) {
      const { rows: sched } = await client.query(`SELECT id FROM lease_schedule_lines WHERE lease_id=$1 AND due_date=$2 ORDER BY line_no ASC LIMIT 1`, [leaseId, toISODate(payload.due_date)]);
      scheduleLineId = sched[0]?.id || null;
    }
    const { rows } = await client.query(`INSERT INTO lease_payments(lease_id,organization_id,due_date,amount,payment_type,is_actual,paid_date,reference,schedule_line_id,created_by)
      VALUES($1,$2,$3,$4,$5,COALESCE($6,FALSE),$7,$8,$9,$10) RETURNING *`, [leaseId, orgId, toISODate(payload.due_date), payload.amount, payload.payment_type || 'fixed', payload.is_actual ?? false, payload.paid_date ? toISODate(payload.paid_date) : null, payload.reference || null, scheduleLineId, actorUserId]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'PAYMENT_RECORDED', payload: rows[0] }); await client.query('COMMIT'); return rows[0];
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }

async function generateSchedule({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lease = await getLeaseBase({ orgId, leaseId, client });
    assertLeaseStatusAllowed(lease, ['draft','active'], 'Schedule generation');
    if (payload.replace) await client.query(`DELETE FROM lease_schedule_lines WHERE lease_id=$1`, [leaseId]);
    else {
      const { rows } = await client.query(`SELECT 1 FROM lease_schedule_lines WHERE lease_id=$1 LIMIT 1`, [leaseId]);
      if (rows.length) throw new AppError(409, 'Schedule already exists. Use replace=true to regenerate.');
    }

    const paymentsPerYear = toDecimal(lease.payments_per_year || 12);
    const termMonths = toDecimal(lease.term_months); const nPeriods = termMonths.times(paymentsPerYear).div(12);
    if (!nPeriods.isInteger() || !nPeriods.greaterThan(0)) throw new AppError(400, 'Term months and payments_per_year must produce a whole number of periods');
    const payment = toDecimal(lease.payment_amount); const periodicRate = toDecimal(lease.annual_discount_rate).div(paymentsPerYear); const timing = lease.payment_timing || 'arrears';
    const monthsPerPeriod = new Decimal(12).div(paymentsPerYear); if (!monthsPerPeriod.isInteger()) throw new AppError(400,'payments_per_year must divide 12 evenly');
    const initialLiability = calculatePresentValue({ payment, annualDiscountRate: lease.annual_discount_rate, periods: nPeriods, paymentsPerYear, paymentTiming: timing });
    const preciseLiability = initialLiability.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN); let periodicDepreciation = preciseLiability.div(nPeriods).toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
    let opening = preciseLiability; const startDate = new Date(lease.commencement_date); const totalPeriods = nPeriods.toNumber();
    for (let i=1;i<=totalPeriods;i++) {
      const offsetPeriods = timing === 'advance' ? (i-1) : i; const dueDate = addMonths(startDate, monthsPerPeriod.times(offsetPeriods).toNumber());
      let interest, principal, closing, currentPayment = payment;
      if (timing === 'advance') {
        principal = (i===totalPeriods) ? opening : payment; const afterPayment = opening.minus(principal); interest = (i===totalPeriods) ? new Decimal(0) : afterPayment.times(periodicRate); closing = afterPayment.plus(interest);
      } else {
        interest = opening.times(periodicRate); principal = payment.minus(interest); if (principal.lessThan(0)) throw new AppError(400, 'Payment amount is too low for the discount rate; schedule would go negative');
        if (i===totalPeriods) { principal = opening; currentPayment = principal.plus(interest); closing = new Decimal(0); } else closing = opening.minus(principal);
      }
      let depreciationForPeriod = periodicDepreciation; if (i===totalPeriods) depreciationForPeriod = preciseLiability.minus(periodicDepreciation.times(new Decimal(totalPeriods-1)));
      const openingRounded = opening.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN); const paymentRounded = currentPayment.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN); const interestRounded = interest.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
      const principalRounded = principal.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN); const closingRounded = closing.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN); const depRounded = depreciationForPeriod.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
      const { rows: inserted } = await client.query(`INSERT INTO lease_schedule_lines(lease_id,line_no,due_date,opening_balance,payment_amount,interest_amount,principal_amount,closing_balance,depreciation_amount,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,due_date,payment_amount`, [leaseId,i,toISODate(dueDate),openingRounded.toNumber(),paymentRounded.toNumber(),interestRounded.toNumber(),principalRounded.toNumber(),closingRounded.toNumber(),depRounded.toNumber(),actorUserId]);
      await client.query(`INSERT INTO lease_payments(lease_id,organization_id,due_date,amount,payment_type,is_actual,schedule_line_id,created_by,reference)
        VALUES($1,$2,$3,$4,'fixed',FALSE,$5,$6,$7)
        ON CONFLICT (lease_id, due_date, payment_type, is_actual, reference) DO NOTHING`, [leaseId, orgId, inserted[0].due_date, inserted[0].payment_amount, inserted[0].id, actorUserId, `schedule:${i}`]);
      opening = closing;
    }
    await client.query(`UPDATE leases SET initial_lease_liability=$2, monthly_depreciation_amount=$3, updated_at=NOW() WHERE id=$1 AND organization_id=$4`, [leaseId, preciseLiability.toNumber(), periodicDepreciation.toNumber(), orgId]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'SCHEDULE_GENERATED', payload:{ periods: totalPeriods, replaced: !!payload.replace } });
    await client.query('COMMIT');
    return { lease_id: leaseId, initial_lease_liability: toCurrencyNumber(preciseLiability), precise_liability: preciseLiability.toNumber(), monthly_depreciation_amount: toCurrencyNumber(periodicDepreciation), precise_depreciation: periodicDepreciation.toNumber(), lines_created: totalPeriods, calculation_decimals: 6, currency_decimals: 2 };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function getSchedule({ orgId, leaseId }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_schedule_lines WHERE lease_id=$1 ORDER BY line_no ASC`, [leaseId]); return { lease_id: leaseId, lines: rows }; }

async function createLeaseModification({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const lease = await getLeaseBase({ orgId, leaseId, client }); assertLeaseStatusAllowed(lease,['draft','active'],'Lease modification');
    const { rows } = await client.query(`INSERT INTO lease_modifications(lease_id,organization_id,effective_date,reason,status,new_term_months,new_payment_amount,new_payments_per_year,new_annual_discount_rate,new_payment_timing,created_by)
      VALUES($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10) RETURNING *`, [leaseId,orgId,toISODate(payload.effective_date),payload.reason || null,payload.new_term_months || null,payload.new_payment_amount || null,payload.new_payments_per_year || null,payload.new_annual_discount_rate || null,payload.new_payment_timing || null,actorUserId]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_CREATED', payload: rows[0] }); await client.query('COMMIT'); return rows[0];
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function listLeaseModifications({ orgId, leaseId }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_modifications WHERE organization_id=$1 AND lease_id=$2 ORDER BY effective_date DESC, created_at DESC`, [orgId, leaseId]); return { items: rows }; }
async function getLeaseModification({ orgId, leaseId, modificationId }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_modifications WHERE organization_id=$1 AND lease_id=$2 AND id=$3 LIMIT 1`, [orgId, leaseId, modificationId]); if (!rows.length) throw new AppError(404,'Lease modification not found'); return rows[0]; }

async function submitLeaseWorkflow({ orgId, actorUserId, leaseId }) {
  const client = await pool.connect(); try { await client.query('BEGIN'); const snapshot = await getLeaseSnapshot({ orgId, leaseId, client }); const lease = snapshot.lease; const result = await workflow.submitLeaseForApproval({ orgId, actorUserId, lease, snapshot, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'LEASE_SUBMITTED', payload:{} }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function approveLease({ orgId, actorUserId, leaseId, comment }) { const client = await pool.connect(); try { await client.query('BEGIN'); const lease = await getLeaseBase({ orgId, leaseId, client }); const result = await workflow.approveLeaseWorkflow({ orgId, actorUserId, lease, comment, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'LEASE_APPROVED', payload:{ final_approval: result.final_approval } }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function rejectLease({ orgId, actorUserId, leaseId, comment }) { const client = await pool.connect(); try { await client.query('BEGIN'); const lease = await getLeaseBase({ orgId, leaseId, client }); const result = await workflow.rejectLeaseWorkflow({ orgId, actorUserId, lease, comment, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'LEASE_REJECTED', payload:{ comment: comment || null } }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }

async function submitLeaseModification({ orgId, actorUserId, leaseId, modificationId }) { const client = await pool.connect(); try { await client.query('BEGIN'); const lease = await getLeaseBase({ orgId, leaseId, client }); const modification = await getLeaseModification({ orgId, leaseId, modificationId }); const result = await workflow.submitLeaseModificationForApproval({ orgId, actorUserId, modification, snapshot:{ lease, modification }, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_SUBMITTED', payload:{ modification_id: modificationId } }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function approveLeaseModification({ orgId, actorUserId, leaseId, modificationId, comment }) { const client = await pool.connect(); try { await client.query('BEGIN'); const modification = await getLeaseModification({ orgId, leaseId, modificationId }); const result = await workflow.approveLeaseModificationWorkflow({ orgId, actorUserId, modification, comment, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_APPROVED', payload:{ modification_id: modificationId, final_approval: result.final_approval } }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function rejectLeaseModification({ orgId, actorUserId, leaseId, modificationId, comment }) { const client = await pool.connect(); try { await client.query('BEGIN'); const modification = await getLeaseModification({ orgId, leaseId, modificationId }); const result = await workflow.rejectLeaseModificationWorkflow({ orgId, actorUserId, modification, comment, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_REJECTED', payload:{ modification_id: modificationId, comment: comment || null } }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }

async function applyLeaseModification({ orgId, actorUserId, leaseId, modificationId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lease = await getLeaseBase({ orgId, leaseId, client });
    assertLeaseStatusAllowed(lease, ['active','draft'], 'Lease modification apply');
    const { rows } = await client.query(`SELECT * FROM lease_modifications WHERE organization_id=$1 AND lease_id=$2 AND id=$3 FOR UPDATE`, [orgId, leaseId, modificationId]);
    if (!rows.length) throw new AppError(404,'Lease modification not found');
    const modification = rows[0];
    if (!['draft','approved'].includes(modification.status)) throw new AppError(409, 'Only draft/approved modifications can be applied');
    await workflow.assertLeaseModificationApprovalStateAllowsAction({ orgId, modification, client, actionLabel: 'apply' });

    const effectiveDate = toISODate(modification.effective_date);
    const { rows: futurePosted } = await client.query(`SELECT 1 FROM lease_schedule_lines WHERE lease_id=$1 AND due_date >= $2 AND (posted_interest_payment_journal_id IS NOT NULL OR posted_depreciation_journal_id IS NOT NULL) LIMIT 1`, [leaseId, effectiveDate]);
    if (futurePosted.length) throw new AppError(409, 'Cannot apply modification because future schedule lines are already posted');

    await client.query(`DELETE FROM lease_schedule_lines WHERE lease_id=$1 AND due_date >= $2`, [leaseId, effectiveDate]);
    await client.query(`UPDATE lease_payments SET schedule_line_id=NULL, updated_at=NOW() WHERE lease_id=$1 AND organization_id=$2 AND due_date >= $3 AND is_actual=FALSE`, [leaseId, orgId, effectiveDate]);

    const nextTerm = modification.new_term_months || lease.term_months;
    const nextPayment = modification.new_payment_amount || lease.payment_amount;
    const nextPPY = modification.new_payments_per_year || lease.payments_per_year;
    const nextRate = modification.new_annual_discount_rate ?? lease.annual_discount_rate;
    const nextTiming = modification.new_payment_timing || lease.payment_timing;

    await client.query(`UPDATE leases SET term_months=$3, payment_amount=$4, payments_per_year=$5, annual_discount_rate=$6, payment_timing=$7, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, leaseId, nextTerm, nextPayment, nextPPY, nextRate, nextTiming]);
    await client.query(`UPDATE lease_contracts SET payment_timing=$3, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2`, [orgId, leaseId, nextTiming]);
    await client.query(`UPDATE lease_modifications SET status='applied', applied_at=NOW(), applied_by=$4, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2 AND id=$3`, [orgId, leaseId, modificationId, actorUserId]);

    const period = await findOpenPeriodForDate({ orgId, date: effectiveDate });
    const baseSnapshot = await getLeaseBase({ orgId, leaseId, client });
    const amount = toDecimal(baseSnapshot.initial_lease_liability || 0).toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
    const journalAmount = Math.abs(toCurrencyNumber(amount));
    let postedJournal = null;
    if (journalAmount > 0) {
      const sign = Number(nextPayment) >= Number(lease.payment_amount) ? 1 : -1;
      const idempotencyKey = buildIfrs16IdempotencyKey(['LEASE', leaseId, 'MOD', modificationId]);
      postedJournal = await workflow.createAndPostWorkflowBackedJournal({
        orgId, actorUserId, client, sourceDocument: modification,
        payload: {
          periodId: period.id,
          entryDate: effectiveDate,
          memo: `IFRS16 Lease ${lease.code} - modification ${modificationId}`,
          idempotencyKey,
          lines: sign >= 0 ? [
            { accountId: lease.rou_asset_account_id, debit: journalAmount, credit: 0, memo: 'Lease modification - increase ROU asset' },
            { accountId: lease.lease_liability_account_id, debit: 0, credit: journalAmount, memo: 'Lease modification - increase lease liability' },
          ] : [
            { accountId: lease.lease_liability_account_id, debit: journalAmount, credit: 0, memo: 'Lease modification - decrease lease liability' },
            { accountId: lease.rou_asset_account_id, debit: 0, credit: journalAmount, memo: 'Lease modification - decrease ROU asset' },
          ],
        },
      });
      await recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId: null, modificationId, action:'modification', idempotencyKey, journalEntryId: postedJournal.journalId });
    }

    await generateSchedule({ orgId, actorUserId, leaseId, payload: { replace: true } });
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_APPLIED', payload:{ modification_id: modificationId, journal_id: postedJournal?.journalId || null } });
    await client.query('COMMIT');
    return { applied: true, modification_id: modificationId, journal_id: postedJournal?.journalId || null };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function postInitialRecognition({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM leases WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [leaseId, orgId]);
    if (!rows.length) throw new AppError(404, 'Lease not found');
    const lease = rows[0];
    assertLeaseStatusAllowed(lease,['draft'],'Initial recognition posting');
    await workflow.assertLeaseApprovalStateAllowsAction({ orgId, lease, client, actionLabel: 'post' });
    await assertPostableAccount({ orgId, accountId: lease.rou_asset_account_id, label: 'rou_asset_account_id', client });
    await assertPostableAccount({ orgId, accountId: lease.lease_liability_account_id, label: 'lease_liability_account_id', client });
    if (lease.initial_recognition_journal_id) { await client.query('COMMIT'); return { already_posted: true, journal_id: lease.initial_recognition_journal_id, recognition_date: lease.initial_recognition_date }; }
    const entryDate = payload?.entryDate || payload?.entry_date ? toISODate(payload?.entryDate || payload?.entry_date) : toISODate(lease.commencement_date);
    const period = await findOpenPeriodForDate({ orgId, date: entryDate });
    let initialLiability = lease.initial_lease_liability != null ? toDecimal(lease.initial_lease_liability) : calculatePresentValue({ payment: lease.payment_amount, annualDiscountRate: lease.annual_discount_rate, periods: toDecimal(lease.term_months).times(toDecimal(lease.payments_per_year || 12)).div(12), paymentsPerYear: lease.payments_per_year || 12, paymentTiming: lease.payment_timing || 'arrears' });
    if (!initialLiability.greaterThan(0)) throw new AppError(400,'Initial recognition amount must be greater than 0');
    const preciseAmount = initialLiability.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN); const journalAmount = toCurrencyNumber(preciseAmount); if (journalAmount <= 0) throw new AppError(400,'Amount after rounding is not positive');
    const idempotencyKey = buildIfrs16IdempotencyKey(['LEASE', leaseId, 'INIT']);
    const postedJournal = await workflow.createAndPostWorkflowBackedJournal({
      orgId, actorUserId, client, sourceDocument: lease,
      payload: {
        periodId: period.id, entryDate, memo: payload?.memo || `IFRS16 Lease ${lease.code} - initial recognition`, idempotencyKey,
        lines: [
          { accountId: lease.rou_asset_account_id, debit: journalAmount, credit: 0, memo: 'Recognise right-of-use asset' },
          { accountId: lease.lease_liability_account_id, debit: 0, credit: journalAmount, memo: 'Recognise lease liability' },
        ],
      },
    });
    await client.query(`UPDATE leases SET initial_recognition_journal_id=$2, initial_recognition_date=$3, initial_lease_liability=$4, status='active', activated_at=COALESCE(activated_at,NOW()), updated_at=NOW() WHERE id=$1 AND organization_id=$5`, [leaseId, postedJournal.journalId, entryDate, preciseAmount.toNumber(), orgId]);
    await recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId:null, modificationId:null, action:'initial_recognition', idempotencyKey, journalEntryId: postedJournal.journalId });
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'INITIAL_RECOGNITION_POSTED', payload:{ entry_date: entryDate, journal_id: postedJournal.journalId, amount: journalAmount } });
    await client.query('COMMIT'); return { already_posted:false, journal_id: postedJournal.journalId, recognition_date: entryDate, amount: journalAmount, precise_amount: preciseAmount.toNumber(), currency_decimals:2, calculation_decimals:6 };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function postLeasePeriod({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const lease = await getLeaseBase({ orgId, leaseId, client }); assertLeaseStatusAllowed(lease,['active'],'Periodic posting'); await workflow.assertLeaseApprovalStateAllowsAction({ orgId, lease, client, actionLabel:'post' });
    for (const [field,label] of [[lease.interest_expense_account_id,'interest_expense_account_id'],[lease.lease_liability_account_id,'lease_liability_account_id'],[lease.cash_account_id,'cash_account_id'],[lease.depreciation_expense_account_id,'depreciation_expense_account_id'],[lease.accumulated_depreciation_account_id,'accumulated_depreciation_account_id']]) await assertPostableAccount({ orgId, accountId: field, label, client });
    const from = toISODate(payload.from_date), to = toISODate(payload.to_date);
    const { rows: lines } = await client.query(`SELECT * FROM lease_schedule_lines WHERE lease_id=$1 AND due_date BETWEEN $2 AND $3 ORDER BY due_date ASC FOR UPDATE`, [leaseId, from, to]);
    if (!lines.length) { await client.query('ROLLBACK'); return { posted: 0, message: 'No schedule lines in range' }; }
    let posted = 0; const journalIds = [];
    for (const line of lines) {
      const entryDate = line.due_date; const period = await findOpenPeriodForDate({ orgId, date: entryDate });
      if (payload.post_interest_and_payment && !line.posted_interest_payment_journal_id) {
        const total = toDecimal(line.payment_amount), interest = toDecimal(line.interest_amount), principal = toDecimal(line.principal_amount); const sum = interest.plus(principal); if (sum.minus(total).abs().greaterThan(new Decimal(0.000001))) throw new AppError(400, 'Schedule line does not balance');
        const idempotencyKey = buildIfrs16IdempotencyKey(['LEASE', leaseId, 'LINE', String(line.line_no), 'PAY']);
        const postedJournal = await workflow.createAndPostWorkflowBackedJournal({ orgId, actorUserId, client, sourceDocument: lease, payload:{ periodId: period.id, entryDate, memo: `IFRS16 Lease ${lease.code} - payment #${line.line_no}`, idempotencyKey, lines:[
          { accountId: lease.interest_expense_account_id, debit: toCurrencyNumber(interest), credit: 0, memo: 'Lease interest' },
          { accountId: lease.lease_liability_account_id, debit: toCurrencyNumber(principal), credit: 0, memo: 'Lease principal' },
          { accountId: lease.cash_account_id, debit: 0, credit: toCurrencyNumber(total), memo: 'Lease payment' },
        ]}});
        await client.query(`UPDATE lease_schedule_lines SET posted_interest_payment_journal_id=$2, updated_at=NOW() WHERE id=$1`, [line.id, postedJournal.journalId]);
        await recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId: line.id, modificationId:null, action:'interest_payment', idempotencyKey, journalEntryId: postedJournal.journalId });
        journalIds.push(postedJournal.journalId); posted += 1;
      }
      if (payload.post_depreciation && !line.posted_depreciation_journal_id) {
        const dep = toDecimal(line.depreciation_amount); const idempotencyKey = buildIfrs16IdempotencyKey(['LEASE', leaseId, 'LINE', String(line.line_no), 'DEP']);
        const postedJournal = await workflow.createAndPostWorkflowBackedJournal({ orgId, actorUserId, client, sourceDocument: lease, payload:{ periodId: period.id, entryDate, memo: `IFRS16 Lease ${lease.code} - depreciation #${line.line_no}`, idempotencyKey, lines:[
          { accountId: lease.depreciation_expense_account_id, debit: toCurrencyNumber(dep), credit: 0, memo: 'ROU depreciation' },
          { accountId: lease.accumulated_depreciation_account_id, debit: 0, credit: toCurrencyNumber(dep), memo: 'Accumulated depreciation - ROU' },
        ]}});
        await client.query(`UPDATE lease_schedule_lines SET posted_depreciation_journal_id=$2, updated_at=NOW() WHERE id=$1`, [line.id, postedJournal.journalId]);
        await recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId: line.id, modificationId:null, action:'depreciation', idempotencyKey, journalEntryId: postedJournal.journalId });
        journalIds.push(postedJournal.journalId); posted += 1;
      }
    }
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'PERIOD_POSTED', payload:{ from_date: from, to_date: to, posted_entries: posted, journal_ids: journalIds } });
    await client.query('COMMIT'); return { posted, journal_ids: journalIds };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function updateLeaseStatus({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const { rows } = await client.query(`SELECT * FROM leases WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [leaseId, orgId]); if (!rows.length) throw new AppError(404,'Lease not found'); const lease = rows[0];
    const current = lease.status, nextStatus = payload.status; if (current === nextStatus) { await client.query('COMMIT'); return { changed:false, before: lease, after: lease }; }
    if (current === 'draft' && nextStatus === 'active') throw new AppError(409, 'Use initial recognition posting to activate a lease'); if (current === 'draft' && nextStatus === 'closed') throw new AppError(409, 'Cannot close a draft lease'); if (['closed','terminated'].includes(current)) throw new AppError(409, `Cannot change status from '${current}'`);
    const effectiveDate = payload.effective_date ? toISODate(payload.effective_date) : null;
    if (current === 'active' && nextStatus === 'closed') {
      const { rows: unposted } = await client.query(`SELECT 1 FROM lease_schedule_lines WHERE lease_id=$1 AND (posted_interest_payment_journal_id IS NULL OR posted_depreciation_journal_id IS NULL) LIMIT 1`, [leaseId]);
      if (unposted.length) throw new AppError(409, 'Cannot close lease while there are unposted schedule lines');
    }
    if ((current === 'active' && nextStatus === 'terminated') || (current === 'draft' && nextStatus === 'terminated')) {
      if (!effectiveDate) throw new AppError(400, 'effective_date is required to terminate a lease');
      const { rows: futurePosted } = await client.query(`SELECT 1 FROM lease_schedule_lines WHERE lease_id=$1 AND due_date > $2 AND (posted_interest_payment_journal_id IS NOT NULL OR posted_depreciation_journal_id IS NOT NULL) LIMIT 1`, [leaseId, effectiveDate]);
      if (futurePosted.length) throw new AppError(409, 'Cannot terminate lease because future lines are already posted');
    }
    const { rows: updated } = await client.query(`UPDATE leases SET status=$3, status_reason=$4, terminated_at=CASE WHEN $3='terminated' THEN NOW() ELSE terminated_at END, closed_at=CASE WHEN $3='closed' THEN NOW() ELSE closed_at END, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, leaseId, nextStatus, payload.reason || null]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'STATUS_UPDATED', payload:{ from: current, to: nextStatus, effective_date: effectiveDate, reason: payload.reason || null } });
    await client.query('COMMIT'); return { changed:true, before: lease, after: updated[0] };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function listLeaseEvents({ orgId, leaseId, query }) { await getLeaseBase({ orgId, leaseId, client: pool }); const limit = Math.min(Number(query?.limit || 100), 500); const { rows } = await pool.query(`SELECT * FROM lease_events WHERE organization_id=$1 AND lease_id=$2 ORDER BY created_at DESC LIMIT $3`, [orgId, leaseId, limit]); return { items: rows }; }
async function listLeasePostingLedger({ orgId, leaseId }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_posting_ledger WHERE organization_id=$1 AND lease_id=$2 ORDER BY created_at DESC`, [orgId, leaseId]); return { items: rows }; }

async function getLeaseDashboard({ orgId, query }) {
  const asOfDate = query?.as_of_date ? toISODate(query.as_of_date) : toISODate(new Date());
  const [summary, liability, depreciation, activity] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS lease_count,
                       COUNT(*) FILTER (WHERE status='active')::int AS active_count,
                       COUNT(*) FILTER (WHERE status='draft')::int AS draft_count,
                       COUNT(*) FILTER (WHERE status='terminated')::int AS terminated_count,
                       COUNT(*) FILTER (WHERE status='closed')::int AS closed_count
                FROM leases WHERE organization_id=$1`, [orgId]),
    pool.query(`SELECT COALESCE(SUM(closing_balance),0)::numeric AS liability_balance FROM lease_schedule_lines lsl JOIN leases l ON l.id=lsl.lease_id WHERE l.organization_id=$1 AND lsl.due_date >= $2`, [orgId, asOfDate]),
    pool.query(`SELECT COALESCE(SUM(depreciation_amount),0)::numeric AS scheduled_depreciation FROM lease_schedule_lines lsl JOIN leases l ON l.id=lsl.lease_id WHERE l.organization_id=$1 AND lsl.due_date <= $2`, [orgId, asOfDate]),
    pool.query(`SELECT event_type, COUNT(*)::int AS count FROM lease_events WHERE organization_id=$1 AND created_at >= NOW() - INTERVAL '90 days' GROUP BY event_type ORDER BY count DESC`, [orgId]),
  ]);
  return { as_of_date: asOfDate, summary: summary.rows[0], liability: liability.rows[0], depreciation: depreciation.rows[0], recent_activity: activity.rows };
}

async function getDisclosureReport({ orgId, query }) {
  const asOfDate = query?.as_of_date ? toISODate(query.as_of_date) : toISODate(new Date());
  const [liabilityRollforward, rouRollforward, maturity, expenses] = await Promise.all([
    pool.query(`SELECT l.organization_id,
                       COALESCE(SUM(CASE WHEN l.initial_recognition_date <= $2 THEN l.initial_lease_liability ELSE 0 END),0)::numeric AS opening_liability,
                       COALESCE(SUM(CASE WHEN le.event_type='MODIFICATION_APPLIED' AND le.created_at::date <= $2 THEN COALESCE((le.event_payload->>'amount')::numeric,0) ELSE 0 END),0)::numeric AS modifications,
                       COALESCE(SUM(CASE WHEN lsl.due_date <= $2 THEN lsl.principal_amount ELSE 0 END),0)::numeric AS principal_reduction,
                       COALESCE(SUM(CASE WHEN l.status='terminated' AND l.terminated_at::date <= $2 THEN lsl.closing_balance ELSE 0 END),0)::numeric AS terminations,
                       COALESCE(SUM(CASE WHEN lsl.due_date > $2 THEN lsl.closing_balance ELSE 0 END),0)::numeric AS closing_liability
                  FROM leases l LEFT JOIN lease_schedule_lines lsl ON lsl.lease_id=l.id LEFT JOIN lease_events le ON le.lease_id=l.id
                 WHERE l.organization_id=$1 GROUP BY l.organization_id`, [orgId, asOfDate]),
    pool.query(`SELECT COALESCE(SUM(initial_lease_liability),0)::numeric AS rou_opening_cost,
                       COALESCE(SUM(CASE WHEN initial_recognition_date <= $2 THEN initial_lease_liability ELSE 0 END),0)::numeric AS additions,
                       COALESCE(SUM(CASE WHEN lsl.due_date <= $2 THEN lsl.depreciation_amount ELSE 0 END),0)::numeric AS depreciation,
                       COALESCE(SUM(CASE WHEN status='terminated' AND terminated_at::date <= $2 THEN initial_lease_liability ELSE 0 END),0)::numeric AS disposals
                  FROM leases l LEFT JOIN lease_schedule_lines lsl ON lsl.lease_id=l.id WHERE organization_id=$1`, [orgId, asOfDate]),
    pool.query(`SELECT CASE
                        WHEN due_date <= $2::date + INTERVAL '1 year' THEN 'within_1_year'
                        WHEN due_date <= $2::date + INTERVAL '5 years' THEN '1_to_5_years'
                        ELSE 'after_5_years'
                      END AS bucket,
                      COALESCE(SUM(lsl.payment_amount),0)::numeric AS undiscounted_cash_flows
                 FROM lease_schedule_lines lsl JOIN leases l ON l.id=lsl.lease_id
                WHERE l.organization_id=$1 AND lsl.due_date > $2
                GROUP BY 1 ORDER BY 1`, [orgId, asOfDate]),
    pool.query(`SELECT COALESCE(SUM(lsl.interest_amount) FILTER (WHERE lsl.due_date <= $2),0)::numeric AS interest_expense,
                       COALESCE(SUM(lsl.depreciation_amount) FILTER (WHERE lsl.due_date <= $2),0)::numeric AS depreciation_expense,
                       COALESCE(SUM(lp.amount) FILTER (WHERE lp.is_actual=TRUE AND lp.paid_date <= $2),0)::numeric AS actual_cash_outflow
                  FROM leases l LEFT JOIN lease_schedule_lines lsl ON lsl.lease_id=l.id LEFT JOIN lease_payments lp ON lp.lease_id=l.id AND lp.organization_id=l.organization_id
                 WHERE l.organization_id=$1`, [orgId, asOfDate]),
  ]);
  return { as_of_date: asOfDate, liability_rollforward: liabilityRollforward.rows[0] || {}, rou_rollforward: rouRollforward.rows[0] || {}, maturity_analysis: maturity.rows, expense_summary: expenses.rows[0] || {} };
}

module.exports = {
  listLeases, createLease, getLease, updateLeaseStatus, generateSchedule, getSchedule, postLeasePeriod, postInitialRecognition,
  upsertContract, listAssets, createAsset, updateAsset, deleteAsset, listPayments, createPayment,
  createLeaseModification, listLeaseModifications, getLeaseModification, applyLeaseModification,
  submitLeaseWorkflow, approveLease, rejectLease, submitLeaseModification, approveLeaseModification, rejectLeaseModification,
  listLeaseEvents, listLeasePostingLedger, getLeaseDashboard, getDisclosureReport,
};
