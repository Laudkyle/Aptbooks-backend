const { findOpenPeriodForDate } = require('../../../interfaces/periodManagement.interface');
const {
  pool, AppError, workflow, Decimal,
  toDecimal, toCurrencyNumber, toISODate, buildIfrs16IdempotencyKey,
  recordLeaseEvent, recordLeasePostingLedger, assertPostableAccount, getLeaseBase,
} = require('./common');
const { buildMeasurement, generateScheduleLines, persistMeasurementSnapshot, journalLine } = require('./measurement');

async function loadLeaseMeasurementContext({ orgId, leaseId, client = pool }) {
  const lease = await getLeaseBase({ orgId, leaseId, client });
  const [contractQ, assetsQ] = await Promise.all([
    client.query(`SELECT * FROM lease_contracts WHERE organization_id=$1 AND lease_id=$2 LIMIT 1`, [orgId, leaseId]),
    client.query(`SELECT * FROM lease_assets WHERE organization_id=$1 AND lease_id=$2 ORDER BY is_primary DESC, created_at ASC`, [orgId, leaseId]),
  ]);
  return { lease, contract: contractQ.rows[0] || null, assets: assetsQ.rows };
}

async function replaceScheduleLines({ client, orgId, actorUserId, leaseId, lines }) {
  await client.query(`DELETE FROM lease_schedule_lines WHERE lease_id=$1`, [leaseId]);
  await client.query(`UPDATE lease_payments SET schedule_line_id=NULL, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2 AND is_actual=FALSE`, [orgId, leaseId]);
  for (const line of lines) {
    const { rows: inserted } = await client.query(`INSERT INTO lease_schedule_lines(lease_id,line_no,due_date,opening_balance,payment_amount,interest_amount,principal_amount,closing_balance,depreciation_amount,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,due_date,payment_amount`,
      [leaseId, line.line_no, line.due_date, line.opening_balance, line.payment_amount, line.interest_amount, line.principal_amount, line.closing_balance, line.depreciation_amount, actorUserId]);
    await client.query(`INSERT INTO lease_payments(lease_id,organization_id,due_date,amount,payment_type,is_actual,schedule_line_id,created_by,reference)
      VALUES($1,$2,$3,$4,'fixed',FALSE,$5,$6,$7)
      ON CONFLICT (lease_id, due_date, payment_type, is_actual, reference) DO NOTHING`,
      [leaseId, orgId, inserted[0].due_date, inserted[0].payment_amount, inserted[0].id, actorUserId, `schedule:${line.line_no}`]);
  }
}

async function generateScheduleWithClient({ orgId, actorUserId, leaseId, payload, client }) {
  const { lease, contract, assets } = await loadLeaseMeasurementContext({ orgId, leaseId, client });
  if (!['draft', 'active'].includes(lease.status)) throw new AppError(409, `Schedule generation is not allowed when lease status is '${lease.status}'`);
  if (!payload.replace) {
    const { rows } = await client.query(`SELECT 1 FROM lease_schedule_lines WHERE lease_id=$1 LIMIT 1`, [leaseId]);
    if (rows.length) throw new AppError(409, 'Schedule already exists. Use replace=true to regenerate.');
  }
  const measurement = buildMeasurement({ lease, contract, assets, effectiveDate: lease.commencement_date, override: {} });
  const lines = generateScheduleLines({ lease, measurement, startDate: new Date(lease.commencement_date) });
  await replaceScheduleLines({ client, orgId, actorUserId, leaseId, lines });
  await client.query(`UPDATE leases SET initial_lease_liability=$2, monthly_depreciation_amount=$3, updated_at=NOW() WHERE id=$1 AND organization_id=$4`,
    [leaseId, measurement.leaseLiability.toFixed(6), measurement.periodicDepreciation.toFixed(6), orgId]);
  await client.query(`UPDATE lease_assets SET rou_cost=COALESCE(rou_cost,$3), updated_at=NOW() WHERE lease_id=$1 AND organization_id=$2 AND is_primary=TRUE`, [leaseId, orgId, measurement.initialRouAsset.toFixed(6)]);
  await persistMeasurementSnapshot({ client, orgId, actorUserId, leaseId, snapshotType: 'initial', measurement, payload: {
    term_months: lease.term_months, payments_per_year: lease.payments_per_year,
  } });
  await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'SCHEDULE_GENERATED', payload:{ periods: lines.length, replaced: !!payload.replace, rou_asset_amount: measurement.initialRouAsset.toFixed(6) } });
  return {
    lease_id: leaseId,
    initial_lease_liability: toCurrencyNumber(measurement.leaseLiability),
    rou_asset_amount: toCurrencyNumber(measurement.initialRouAsset),
    monthly_depreciation_amount: toCurrencyNumber(measurement.periodicDepreciation),
    lines_created: lines.length,
    recognition_model: measurement.recognitionModel,
    calculation_decimals: 6,
    currency_decimals: 2,
  };
}

async function generateSchedule({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await generateScheduleWithClient({ orgId, actorUserId, leaseId, payload, client });
    await client.query('COMMIT');
    return result;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function getSchedule({ orgId, leaseId }) {
  await getLeaseBase({ orgId, leaseId, client: pool });
  const { rows } = await pool.query(`SELECT * FROM lease_schedule_lines WHERE lease_id=$1 ORDER BY line_no ASC`, [leaseId]);
  return { lease_id: leaseId, lines: rows };
}

async function postInitialRecognition({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { lease, contract, assets } = await loadLeaseMeasurementContext({ orgId, leaseId, client });
    if (lease.status !== 'draft') throw new AppError(409, `Initial recognition posting is not allowed when lease status is '${lease.status}'`);
    await workflow.assertLeaseApprovalStateAllowsAction({ orgId, lease, client, actionLabel: 'post' });
    if (lease.recognition_model === 'on_balance_sheet') {
      for (const [accountId, label] of [
        [lease.rou_asset_account_id, 'rou_asset_account_id'], [lease.lease_liability_account_id, 'lease_liability_account_id'],
        [lease.depreciation_expense_account_id, 'depreciation_expense_account_id'], [lease.accumulated_depreciation_account_id, 'accumulated_depreciation_account_id'],
      ]) await assertPostableAccount({ orgId, accountId, label, client });
      if (lease.cash_account_id) await assertPostableAccount({ orgId, accountId: lease.cash_account_id, label: 'cash_account_id', client });
    }
    if (lease.initial_recognition_journal_id) { await client.query('COMMIT'); return { already_posted: true, journal_id: lease.initial_recognition_journal_id, recognition_date: lease.initial_recognition_date }; }

    const entryDate = payload?.entryDate || payload?.entry_date ? toISODate(payload?.entryDate || payload?.entry_date) : toISODate(lease.commencement_date);
    const period = await findOpenPeriodForDate({ orgId, date: entryDate });
    const measurement = buildMeasurement({ lease, contract, assets, effectiveDate: entryDate, override: {} });
    if (measurement.recognitionModel !== 'on_balance_sheet') {
      await client.query(`UPDATE leases SET initial_recognition_date=$2, status='active', activated_at=COALESCE(activated_at,NOW()), updated_at=NOW() WHERE id=$1 AND organization_id=$3`, [leaseId, entryDate, orgId]);
      await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'INITIAL_RECOGNITION_EXEMPT', payload:{ entry_date: entryDate, recognition_model: measurement.recognitionModel } });
      await client.query('COMMIT');
      return { already_posted:false, recognition_date: entryDate, exempt:true, recognition_model: measurement.recognitionModel };
    }
    const idempotencyKey = buildIfrs16IdempotencyKey(['LEASE', leaseId, 'INIT']);
    const directCosts = toDecimal(contract?.initial_direct_costs || 0);
    const incentives = toDecimal(contract?.lease_incentives || 0);
    const restoration = toDecimal(contract?.restoration_provision || 0);
    const prepaid = toDecimal(contract?.prepaid_lease_payments || 0);
    const accrued = toDecimal(contract?.accrued_lease_payments || 0);
    if ((directCosts.greaterThan(0) || incentives.greaterThan(0) || prepaid.greaterThan(0)) && !lease.cash_account_id) {
      throw new AppError(409, 'Cash/bank account is required for initial direct costs, incentives, or prepaid lease payments');
    }
    const lines = [
      journalLine(lease.rou_asset_account_id, measurement.initialRouAsset, 0, 'Recognise right-of-use asset'),
      journalLine(lease.lease_liability_account_id, 0, measurement.leaseLiability, 'Recognise lease liability at present value'),
    ];
    if (directCosts.greaterThan(0)) lines.push(journalLine(lease.cash_account_id, 0, directCosts, 'Settle initial direct costs'));
    if (prepaid.greaterThan(0)) lines.push(journalLine(lease.cash_account_id, 0, prepaid, 'Recognise prepaid lease payment included in ROU asset'));
    if (incentives.greaterThan(0)) lines.push(journalLine(lease.cash_account_id, incentives, 0, 'Lease incentive received'));
    if (restoration.greaterThan(0)) lines.push(journalLine(lease.lease_liability_account_id, 0, restoration, 'Recognise restoration-related obligation'));
    if (accrued.greaterThan(0)) lines.push(journalLine(lease.lease_liability_account_id, accrued, 0, 'Accrued lease payments at commencement'));

    const postedJournal = await workflow.createAndPostWorkflowBackedJournal({
      orgId, actorUserId, client, sourceDocument: lease,
      payload: { periodId: period.id, entryDate, memo: payload?.memo || `IFRS16 Lease ${lease.code} - initial recognition`, idempotencyKey, lines },
    });
    await client.query(`UPDATE leases SET initial_recognition_journal_id=$2, initial_recognition_date=$3, initial_lease_liability=$4, monthly_depreciation_amount=$5, status='active', activated_at=COALESCE(activated_at,NOW()), updated_at=NOW() WHERE id=$1 AND organization_id=$6`,
      [leaseId, postedJournal.journalId, entryDate, measurement.leaseLiability.toFixed(6), measurement.periodicDepreciation.toFixed(6), orgId]);
    await client.query(`UPDATE lease_assets SET rou_cost=$3, updated_at=NOW() WHERE lease_id=$1 AND organization_id=$2 AND is_primary=TRUE`, [leaseId, orgId, measurement.initialRouAsset.toFixed(6)]);
    await persistMeasurementSnapshot({ client, orgId, actorUserId, leaseId, snapshotType: 'initial', measurement, payload: { term_months: lease.term_months, payments_per_year: lease.payments_per_year } });
    await recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId:null, modificationId:null, action:'initial_recognition', idempotencyKey, journalEntryId: postedJournal.journalId });
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'INITIAL_RECOGNITION_POSTED', payload:{ entry_date: entryDate, journal_id: postedJournal.journalId, lease_liability_amount: measurement.leaseLiability.toFixed(6), rou_asset_amount: measurement.initialRouAsset.toFixed(6) } });
    await client.query('COMMIT');
    return { already_posted:false, journal_id: postedJournal.journalId, recognition_date: entryDate, amount: toCurrencyNumber(measurement.leaseLiability), rou_asset_amount: toCurrencyNumber(measurement.initialRouAsset), precise_amount: Number(measurement.leaseLiability.toFixed(6)), currency_decimals:2, calculation_decimals:6 };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function postLeasePeriod({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const { lease, contract } = await loadLeaseMeasurementContext({ orgId, leaseId, client });
    if (lease.status !== 'active') throw new AppError(409, `Periodic posting is not allowed when lease status is '${lease.status}'`);
    await workflow.assertLeaseApprovalStateAllowsAction({ orgId, lease, client, actionLabel:'post' });
    const exemptRecognition = ['short_term_exempt', 'low_value_exempt'].includes(lease.recognition_model);
    const neededAccounts = exemptRecognition
      ? [[lease.depreciation_expense_account_id,'lease_expense_account_id'],[lease.cash_account_id,'cash_account_id']]
      : [[lease.interest_expense_account_id,'interest_expense_account_id'],[lease.lease_liability_account_id,'lease_liability_account_id'],[lease.cash_account_id,'cash_account_id'],[lease.depreciation_expense_account_id,'depreciation_expense_account_id'],[lease.accumulated_depreciation_account_id,'accumulated_depreciation_account_id']];
    for (const [field,label] of neededAccounts) await assertPostableAccount({ orgId, accountId: field, label, client });
    const from = toISODate(payload.from_date), to = toISODate(payload.to_date);
    const { rows: lines } = await client.query(`SELECT * FROM lease_schedule_lines WHERE lease_id=$1 AND due_date BETWEEN $2 AND $3 ORDER BY due_date ASC FOR UPDATE`, [leaseId, from, to]);
    if (!lines.length) { await client.query('ROLLBACK'); return { posted: 0, message: 'No schedule lines in range' }; }
    let posted = 0; const journalIds = [];
    for (const line of lines) {
      const entryDate = line.due_date; const period = await findOpenPeriodForDate({ orgId, date: entryDate });
      if (payload.post_interest_and_payment && !line.posted_interest_payment_journal_id) {
        const total = toDecimal(line.payment_amount), interest = toDecimal(line.interest_amount), principal = toDecimal(line.principal_amount);
        const idempotencyKey = buildIfrs16IdempotencyKey(['LEASE', leaseId, 'LINE', String(line.line_no), 'PAY']);
        const postLines = exemptRecognition
          ? [journalLine(lease.depreciation_expense_account_id, total, 0, `Lease expense (${lease.recognition_model})`), journalLine(lease.cash_account_id, 0, total, 'Lease payment')]
          : [journalLine(lease.interest_expense_account_id, interest, 0, 'Lease interest'), journalLine(lease.lease_liability_account_id, principal, 0, 'Lease principal'), journalLine(lease.cash_account_id, 0, total, 'Lease payment')];
        const postedJournal = await workflow.createAndPostWorkflowBackedJournal({ orgId, actorUserId, client, sourceDocument: lease, payload:{ periodId: period.id, entryDate, memo: `IFRS16 Lease ${lease.code} - payment #${line.line_no}`, idempotencyKey, lines: postLines }});
        await client.query(`UPDATE lease_schedule_lines SET posted_interest_payment_journal_id=$2, updated_at=NOW() WHERE id=$1`, [line.id, postedJournal.journalId]);
        await recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId: line.id, modificationId:null, action:'interest_payment', idempotencyKey, journalEntryId: postedJournal.journalId });
        journalIds.push(postedJournal.journalId); posted += 1;
      }
      if (!exemptRecognition && payload.post_depreciation && !line.posted_depreciation_journal_id) {
        const dep = toDecimal(line.depreciation_amount); const idempotencyKey = buildIfrs16IdempotencyKey(['LEASE', leaseId, 'LINE', String(line.line_no), 'DEP']);
        const postedJournal = await workflow.createAndPostWorkflowBackedJournal({ orgId, actorUserId, client, sourceDocument: lease, payload:{ periodId: period.id, entryDate, memo: `IFRS16 Lease ${lease.code} - depreciation #${line.line_no}`, idempotencyKey, lines:[
          journalLine(lease.depreciation_expense_account_id, dep, 0, 'ROU depreciation'),
          journalLine(lease.accumulated_depreciation_account_id, 0, dep, 'Accumulated depreciation - ROU'),
        ]}});
        await client.query(`UPDATE lease_schedule_lines SET posted_depreciation_journal_id=$2, updated_at=NOW() WHERE id=$1`, [line.id, postedJournal.journalId]);
        await recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId: line.id, modificationId:null, action:'depreciation', idempotencyKey, journalEntryId: postedJournal.journalId });
        journalIds.push(postedJournal.journalId); posted += 1;
      }
    }
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'PERIOD_POSTED', payload:{ from_date: from, to_date: to, posted_entries: posted, journal_ids: journalIds, recognition_model: lease.recognition_model } });
    await client.query('COMMIT'); return { posted, journal_ids: journalIds };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

module.exports = {
  generateSchedule,
  getSchedule,
  postInitialRecognition,
  postLeasePeriod,
  generateScheduleWithClient,
  loadLeaseMeasurementContext,
};
