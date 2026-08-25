const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const journalIF = require("../../../interfaces/journalPosting.interface");
const repo = require("./depreciation.repository");
const assetRepo = require("../fixed-assets/fixedAssets.repository");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");
const {
  moneyUnits, moneyStringFromUnits, sumMoneyUnits, absUnits, periodicDepreciationUnits,
} = require("../../../shared/utils/financialMath");
const { parseDecimalToBigInt, divideAndRoundHalfUp, powerOfTen } = require("../../../shared/utils/money");

const DAY_MS = 86400000;

function sumMoney(lines) {
  const debitUnits = sumMoneyUnits(lines.map((line) => line.debit || "0"));
  const creditUnits = sumMoneyUnits(lines.map((line) => line.credit || "0"));
  return { debit: moneyStringFromUnits(debitUnits), credit: moneyStringFromUnits(creditUnits), balanced: debitUnits === creditUnits };
}

function dateUtc(value) {
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function dateText(date) { return date.toISOString().slice(0, 10); }
function maxDate(...values) { return values.filter(Boolean).map(dateUtc).sort((a,b) => b-a)[0] || null; }
function minDate(...values) { return values.filter(Boolean).map(dateUtc).sort((a,b) => a-b)[0] || null; }
function inclusiveDays(start, end) { return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1; }
function addMonthsClamped(value, months) {
  const source = dateUtc(value);
  const y = source.getUTCFullYear();
  const m = source.getUTCMonth();
  const d = source.getUTCDate();
  const first = new Date(Date.UTC(y, m + Number(months), 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay)));
}
function dayBefore(date) { return new Date(date.getTime() - DAY_MS); }

async function assertPeriodOpen(orgId, periodId, client = null) {
  const database = client || pool;
  const { rows } = await database.query(
    `SELECT id, status, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`, [orgId, periodId]);
  if (!rows.length) throw new AppError(400, "Invalid periodId");
  if (rows[0].status !== "open") throw new AppError(409, "Period is not open");
  return rows[0];
}

async function assetBookState({ orgId, asset, client = null }) {
  const database = client || pool;
  const [{ rows: dep }, { rows: rev }] = await Promise.all([
    database.query(`SELECT COALESCE(SUM(amount),0)::numeric AS amount FROM asset_depreciation_transactions WHERE organization_id=$1 AND asset_id=$2`, [orgId, asset.id]),
    database.query(`SELECT COALESCE(SUM(CASE WHEN payload_json ? 'delta' THEN (payload_json->>'delta')::numeric ELSE 0 END),0)::numeric AS amount
                      FROM asset_events WHERE organization_id=$1 AND asset_id=$2 AND event_type='revaluation'`, [orgId, asset.id]),
  ]);
  const cost = moneyUnits(asset.cost || '0');
  const depreciation = moneyUnits(dep[0]?.amount || '0');
  const revaluation = moneyUnits(rev[0]?.amount || '0');
  const impairment = moneyUnits(asset.impairment_total || '0');
  return { grossBookUnits: cost + revaluation - impairment, accumulatedUnits: depreciation };
}

async function materializeSchedulePayload({ orgId, actorUserId, payload, client }) {
  const asset = await assetRepo.getAssetWithCategoryAccounts({ orgId, assetId: payload.assetId, client, forUpdate: true });
  if (!asset) throw new AppError(400, "Invalid assetId");
  if (!['active','retired'].includes(asset.status)) throw new AppError(409, "Asset must be acquired before a depreciation schedule can be created");

  const method = payload.method || asset.default_depreciation_method || 'straight_line';
  const usefulLifeMonths = payload.usefulLifeMonths || asset.default_useful_life_months;
  if (!usefulLifeMonths) throw new AppError(422, "Useful life is required. Set it on the asset category or schedule.");
  const depreciationConvention = payload.depreciationConvention || asset.default_depreciation_convention || 'full_month';
  const decliningRatePercent = method === 'reducing_balance'
    ? (payload.decliningRatePercent ?? asset.default_declining_rate_percent)
    : null;
  if (method === 'reducing_balance' && !decliningRatePercent) throw new AppError(422, "Reducing-balance depreciation requires a rate");

  const effectiveStartDate = payload.effectiveStartDate || payload.depreciationStartDate || asset.in_service_date || asset.acquisition_date;
  if (!effectiveStartDate) throw new AppError(422, "Effective start date is required");
  if (effectiveStartDate < asset.acquisition_date) throw new AppError(422, "Depreciation cannot start before acquisition date");
  if (payload.effectiveEndDate && payload.effectiveEndDate < effectiveStartDate) throw new AppError(422, "Effective end date cannot be before start date");

  const book = await assetBookState({ orgId, asset, client });
  const component = String(payload.componentCode || '').trim() || null;
  if (component && payload.basisAmount == null) {
    throw new AppError(422, "Component schedules require an explicit basisAmount so the asset cannot be depreciated twice");
  }
  const basisAmount = payload.basisAmount ?? moneyStringFromUnits(book.grossBookUnits);
  const residualValue = payload.residualValue ?? (component ? '0.00' : asset.salvage_value || '0.00');
  const basisUnits = moneyUnits(basisAmount);
  const residualUnits = moneyUnits(residualValue);
  if (basisUnits <= 0n) throw new AppError(422, "Depreciation basis must be greater than zero");
  if (residualUnits < 0n || residualUnits > basisUnits) throw new AppError(422, "Residual value must be between zero and the depreciation basis");

  const { rows: overlappingBasis } = await client.query(
    `SELECT COALESCE(SUM(basis_amount),0)::numeric AS amount
       FROM asset_depreciation_schedules
      WHERE organization_id=$1 AND asset_id=$2 AND status='active'
        AND effective_start_date <= COALESCE($4::date,'9999-12-31'::date)
        AND COALESCE(effective_end_date,'9999-12-31'::date) >= $3::date`,
    [orgId, asset.id, effectiveStartDate, payload.effectiveEndDate || null]);
  const alreadyAllocated = moneyUnits(overlappingBasis[0]?.amount || '0');
  if (alreadyAllocated + basisUnits > book.grossBookUnits) {
    throw new AppError(409, "Concurrent depreciation schedules allocate more than the asset's current gross book amount");
  }

  return {
    ...payload, assetId: asset.id, method, usefulLifeMonths, depreciationConvention,
    decliningRatePercent, effectiveStartDate, depreciationStartDate: effectiveStartDate,
    componentCode: component, basisAmount: moneyStringFromUnits(basisUnits), residualValue: moneyStringFromUnits(residualUnits),
    actorUserId,
  };
}

async function createSchedule({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`asset-depr-schedule:${orgId}:${payload.assetId}`]);
    const normalized = await materializeSchedulePayload({ orgId, actorUserId, payload, client });
    const created = await repo.createSchedule({ orgId, actorUserId, payload: normalized, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'create', entityType: 'asset_depreciation_schedule', entityId: created.id,
      before: null, after: created, client });
    await client.query('COMMIT');
    return created;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function listSchedules({ orgId, query }) { return repo.listSchedules({ orgId, query }); }
async function getSchedule({ orgId, scheduleId }) {
  const schedule = await repo.getSchedule({ orgId, scheduleId });
  if (!schedule) throw new AppError(404, "Schedule not found");
  return schedule;
}

async function updateSchedule({ orgId, actorUserId, scheduleId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await repo.getSchedule({ orgId, scheduleId, client, forUpdate: true });
    if (!before) throw new AppError(404, "Schedule not found");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`asset-depr-schedule:${orgId}:${before.asset_id}`]);
    const hasPostings = await repo.hasPostings({ orgId, scheduleId, client });
    const onlyStatusChange = Object.keys(payload).every((key) => key === 'status');
    if (hasPostings && !onlyStatusChange) throw new AppError(409, "Posted schedules are immutable; deactivate this schedule and create a replacement");

    if (!hasPostings) {
      const asset = await assetRepo.getAssetWithCategoryAccounts({ orgId, assetId: before.asset_id, client, forUpdate: true });
      const nextBasis = payload.basisAmount ?? before.basis_amount;
      const nextResidual = payload.residualValue ?? before.residual_value;
      if (moneyUnits(nextResidual) > moneyUnits(nextBasis)) throw new AppError(422, "Residual value cannot exceed depreciation basis");
      if ((payload.method ?? before.method) === 'reducing_balance' && !(payload.decliningRatePercent ?? before.declining_rate_percent)) {
        throw new AppError(422, "Reducing-balance depreciation requires a rate");
      }
      if (!asset) throw new AppError(404, 'Asset not found');
    }
    const updated = await repo.updateSchedule({ orgId, scheduleId, payload, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'update', entityType: 'asset_depreciation_schedule', entityId: scheduleId,
      before, after: updated, client });
    await client.query('COMMIT');
    return { before, schedule: updated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function deleteSchedule({ orgId, actorUserId, scheduleId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await repo.getSchedule({ orgId, scheduleId, client, forUpdate: true });
    if (!before) throw new AppError(404, "Schedule not found");
    if (await repo.hasPostings({ orgId, scheduleId, client })) throw new AppError(409, "Cannot delete a schedule once depreciation has been posted");
    await repo.deleteSchedule({ orgId, scheduleId, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'delete', entityType: 'asset_depreciation_schedule', entityId: scheduleId,
      before, after: null, client });
    await client.query('COMMIT');
    return { deleted: true, id: scheduleId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function depreciationAmount({ row, accumulatedUnits, postedPeriods, eligibleStart, eligibleEnd }) {
  const basisUnits = moneyUnits(row.basis_amount);
  const residualUnits = moneyUnits(row.residual_value || '0');
  const depreciableBasis = basisUnits - residualUnits;
  const remaining = depreciableBasis - accumulatedUnits;
  if (depreciableBasis <= 0n || remaining <= 0n) return { amountUnits: 0n, calculation: { reason: 'fully_depreciated' } };

  const lifeStart = dateUtc(row.effective_start_date);
  const lifeEndExclusive = addMonthsClamped(row.effective_start_date, Number(row.useful_life_months));
  const lifeEnd = dayBefore(lifeEndExclusive);
  const effectiveEnd = minDate(dateText(eligibleEnd), dateText(lifeEnd));
  if (effectiveEnd < eligibleStart) return { amountUnits: 0n, calculation: { reason: 'outside_useful_life' } };

  let amountUnits = 0n;
  const convention = row.depreciation_convention || 'full_month';
  if (row.method === 'straight_line') {
    if (convention === 'daily_prorata') {
      const totalDays = Math.max(1, Math.floor((lifeEndExclusive.getTime() - lifeStart.getTime()) / DAY_MS));
      const eligibleDays = inclusiveDays(eligibleStart, effectiveEnd);
      amountUnits = divideAndRoundHalfUp(depreciableBasis * BigInt(eligibleDays), BigInt(totalDays));
    } else {
      amountUnits = periodicDepreciationUnits({ basisUnits: depreciableBasis, accumulatedUnits,
        usefulLifePeriods: Number(row.useful_life_months), postedPeriods });
    }
  } else if (row.method === 'reducing_balance') {
    const carryingBefore = basisUnits - accumulatedUnits;
    const rateUnits = parseDecimalToBigInt(String(row.declining_rate_percent || '0'), 6);
    const scale = powerOfTen(6);
    if (convention === 'daily_prorata') {
      const eligibleDays = inclusiveDays(eligibleStart, effectiveEnd);
      amountUnits = divideAndRoundHalfUp(carryingBefore * rateUnits * BigInt(eligibleDays), 100n * scale * 365n);
    } else {
      amountUnits = divideAndRoundHalfUp(carryingBefore * rateUnits, 100n * scale * 12n);
    }
  }
  if (effectiveEnd >= lifeEnd) amountUnits = remaining;
  if (amountUnits > remaining) amountUnits = remaining;
  if (amountUnits < 0n) amountUnits = 0n;
  return { amountUnits, calculation: {
    method: row.method, convention, usefulLifeMonths: Number(row.useful_life_months), postedPeriods,
    eligibleStart: dateText(eligibleStart), eligibleEnd: dateText(effectiveEnd),
    basisAmount: row.basis_amount, residualValue: row.residual_value,
    accumulatedBefore: moneyStringFromUnits(accumulatedUnits), remainingBefore: moneyStringFromUnits(remaining),
    decliningRatePercent: row.declining_rate_percent || null,
  }};
}

async function computePeriodDepreciation({ orgId, periodId, client = null }) {
  const database = client || pool;
  const period = await assertPeriodOpen(orgId, periodId, client);
  const { rows } = await database.query(
    `SELECT a.id AS asset_id, a.code AS asset_code, a.name AS asset_name, a.status AS asset_status,
            a.acquisition_date, a.in_service_date, a.disposed_date,
            s.id AS schedule_id, s.method, s.useful_life_months, s.component_code,
            s.effective_start_date, s.effective_end_date, s.basis_amount, s.residual_value,
            s.depreciation_convention, s.declining_rate_percent,
            c.depr_expense_account_id, c.accum_depr_account_id,
            COALESCE(ds.amount,0)::numeric AS accumulated_amount,
            COALESCE(ds.posted_periods,0)::int AS posted_periods
       FROM asset_depreciation_schedules s
       JOIN fixed_assets a ON a.id=s.asset_id AND a.organization_id=s.organization_id
       JOIN asset_categories c ON c.id=a.category_id AND c.organization_id=a.organization_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(t.amount),0) AS amount,
                COUNT(DISTINCT t.period_id) FILTER (WHERE t.entry_type='depreciation' AND NOT EXISTS (
                  SELECT 1 FROM asset_depreciation_transactions r
                   WHERE r.organization_id=t.organization_id AND r.schedule_id=t.schedule_id AND r.period_id=t.period_id AND r.entry_type='reversal'
                )) AS posted_periods
           FROM asset_depreciation_transactions t
          WHERE t.organization_id=s.organization_id AND t.schedule_id=s.id
       ) ds ON TRUE
      WHERE s.organization_id=$1 AND s.status='active'
        AND a.status IN ('active','retired','disposed')
        AND a.acquisition_journal_entry_id IS NOT NULL
        AND s.effective_start_date <= $3::date
        AND (s.effective_end_date IS NULL OR s.effective_end_date >= $2::date)
        AND (a.disposed_date IS NULL OR a.disposed_date >= $2::date)
      ORDER BY a.code, COALESCE(s.component_code,''), s.effective_start_date`,
    [orgId, period.start_date, period.end_date]);

  const postings = [];
  for (const row of rows) {
    const eligibleStart = maxDate(period.start_date, row.effective_start_date, row.in_service_date || row.acquisition_date);
    const eligibleEnd = minDate(period.end_date, row.effective_end_date, row.disposed_date);
    if (!eligibleStart || !eligibleEnd || eligibleEnd < eligibleStart) continue;
    const { amountUnits, calculation } = depreciationAmount({ row, accumulatedUnits: moneyUnits(row.accumulated_amount || '0'),
      postedPeriods: Number(row.posted_periods || 0), eligibleStart, eligibleEnd });
    if (amountUnits <= 0n) continue;
    if (!row.depr_expense_account_id) throw new AppError(409, `Category missing depreciation expense account for asset ${row.asset_code}`);
    if (!row.accum_depr_account_id) throw new AppError(409, `Category missing accumulated depreciation account for asset ${row.asset_code}`);
    const amount = moneyStringFromUnits(amountUnits);
    const component = row.component_code ? ` · ${row.component_code}` : '';
    postings.push({
      assetId: row.asset_id, scheduleId: row.schedule_id, assetCode: row.asset_code, assetName: row.asset_name,
      componentCode: row.component_code || null, amount, method: row.method,
      basisAmount: row.basis_amount, residualValue: row.residual_value, calculation,
      expenseAccountId: row.depr_expense_account_id, accumAccountId: row.accum_depr_account_id,
      memo: `Depreciation · ${row.asset_code} · ${row.asset_name}${component}`,
    });
  }
  const journalLines = postings.flatMap((posting) => [
    { accountId: posting.expenseAccountId, debit: posting.amount, credit: '0.00', description: posting.memo },
    { accountId: posting.accumAccountId, debit: '0.00', credit: posting.amount, description: posting.memo },
  ]);
  return { period, postings, journalLines, totals: sumMoney(journalLines) };
}

async function listDepreciationRuns({ orgId, limit }) { return repo.listRuns({ orgId, limit }); }

async function previewPeriodEndDepreciation({ orgId, periodId }) {
  const { period, postings, journalLines, totals } = await computePeriodDepreciation({ orgId, periodId });
  return { periodId: period.id, periodStartDate: period.start_date, periodEndDate: period.end_date,
    postings, journalLines, totals, count: postings.length };
}

async function persistFailedRun({ orgId, actorUserId, periodId, error }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await repo.createOrRestartRun({ orgId, periodId, actorUserId, client });
    if (run && run.status !== 'posted') await repo.markRun({ orgId, runId: run.id, status: 'failed', error: String(error?.message || error).slice(0, 2000), client });
    await client.query('COMMIT');
  } catch (_) { try { await client.query('ROLLBACK'); } catch (_) {} }
  finally { client.release(); }
}

async function runPeriodEndDepreciation({ orgId, actorUserId, periodId, entryDate, memo }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`depr:${orgId}:${periodId}`]);
    const period = await assertPeriodOpen(orgId, periodId, client);
    const postingDate = entryDate || period.end_date;
    if (postingDate < period.start_date || postingDate > period.end_date) throw new AppError(422, 'Depreciation posting date must be inside the selected period');

    const existing = await repo.getRunByPeriod({ orgId, periodId, client, forUpdate: true });
    if (existing?.status === 'posted') {
      await client.query('COMMIT');
      return { status: 'skipped', reason: 'already_posted', run: existing };
    }
    if (existing?.status === 'running') throw new AppError(409, 'Depreciation run is already in progress', null, 'DEPRECIATION_RUN_IN_PROGRESS');
    const run = await repo.createOrRestartRun({ orgId, periodId, actorUserId, client });
    if (!run) throw new AppError(409, 'Depreciation run could not be started');

    const { postings, journalLines, totals } = await computePeriodDepreciation({ orgId, periodId, client });
    if (!postings.length) {
      await repo.markRun({ orgId, runId: run.id, status: 'skipped', controlTotal: '0.00', client });
      await client.query('COMMIT');
      return { status: 'skipped', runId: run.id, reason: 'no_eligible_assets' };
    }
    if (!totals.balanced) throw new AppError(500, 'Depreciation journal is not balanced');

    const posted = await journalIF.postSourceJournal({
      orgId, actorUserId, client, sourceType: 'asset_depreciation_run', sourceId: run.id,
      sourceAction: 'period_end', sourceReference: periodId, sourceModule: 'assets',
      payload: { periodId, entryDate: postingDate, typeCode: 'ADJUSTMENT',
        memo: memo || `Period depreciation (${periodId})`, idempotencyKey: `depr:${orgId}:${periodId}`, lines: journalLines },
    });
    await repo.linkRunPosting({ runId: run.id, journalId: posted.journalId, client });
    await repo.insertDepreciationTransactions({ orgId, periodId, postings, journalId: posted.journalId, client });
    await repo.markRun({ orgId, runId: run.id, status: 'posted', controlTotal: totals.debit, client });

    for (const posting of postings) {
      await assetRepo.insertAssetEvent({ orgId, assetId: posting.assetId, eventType: 'depreciation_run', eventDate: postingDate,
        memo: posting.memo, payloadJson: { runId: run.id, periodId, amount: posting.amount, scheduleId: posting.scheduleId,
          journalId: posted.journalId, calculation: posting.calculation }, createdBy: actorUserId, client });
    }
    await writeAudit({ organizationId: orgId, actorUserId, action: 'post', entityType: 'asset_depreciation_run', entityId: run.id,
      before: null, after: { periodId, journalId: posted.journalId, count: postings.length, total: totals.debit }, client });
    await client.query('COMMIT');
    return { status: 'posted', runId: run.id, journalId: posted.journalId, count: postings.length, total: totals.debit };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error?.code !== 'DEPRECIATION_RUN_IN_PROGRESS') {
      await persistFailedRun({ orgId, actorUserId, periodId, error });
    }
    throw error;
  } finally { client.release(); }
}

async function reversePeriodEndDepreciation({ orgId, actorUserId, periodId, entryDate, memo }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`depr:${orgId}:${periodId}`]);
    const period = await assertPeriodOpen(orgId, periodId, client);
    const postingDate = entryDate || period.end_date;
    if (postingDate < period.start_date || postingDate > period.end_date) throw new AppError(422, 'Reversal date must be inside the selected open period');
    const run = await repo.getRunByPeriod({ orgId, periodId, client, forUpdate: true });
    if (!run) throw new AppError(409, 'No depreciation run exists for this period');
    if (run.status === 'reversed') {
      await client.query('COMMIT');
      return { status: 'reversed', idempotent: true, journalId: run.reversal_journal_entry_id };
    }
    if (run.status !== 'posted' || !run.journal_entry_id) throw new AppError(409, 'Only a posted depreciation run can be reversed');

    const { rows } = await client.query(
      `SELECT t.asset_id, t.schedule_id, t.amount, t.method, t.basis_amount, t.residual_value, t.calculation_json,
              a.code AS asset_code, a.name AS asset_name
         FROM asset_depreciation_transactions t
         JOIN fixed_assets a ON a.id=t.asset_id AND a.organization_id=t.organization_id
        WHERE t.organization_id=$1 AND t.period_id=$2 AND t.entry_type='depreciation'`, [orgId, periodId]);
    if (!rows.length) throw new AppError(409, 'No depreciation transactions were found for the run');

    const reversal = await journalIF.reversePostedJournal({ orgId, journalId: run.journal_entry_id, actorUserId,
      targetPeriodId: periodId, entryDate: postingDate, reason: memo || `Depreciation reversal (${periodId})`,
      idempotencyKey: `depr-rev:${orgId}:${periodId}`, client });
    const postings = rows.map((row) => ({ assetId: row.asset_id, scheduleId: row.schedule_id,
      amount: moneyStringFromUnits(absUnits(moneyUnits(row.amount))), method: row.method,
      basisAmount: row.basis_amount, residualValue: row.residual_value,
      calculation: { ...(row.calculation_json || {}), reversalOfJournalId: run.journal_entry_id } }));
    await repo.insertDepreciationTransactions({ orgId, periodId, postings, entryType: 'reversal',
      journalId: reversal.reversalJournalId, client });
    await repo.markRunReversed({ orgId, runId: run.id, reversalJournalId: reversal.reversalJournalId, actorUserId, client });
    for (const posting of postings) {
      await assetRepo.insertAssetEvent({ orgId, assetId: posting.assetId, eventType: 'depreciation_reversal', eventDate: postingDate,
        memo: memo || `Depreciation reversal (${periodId})`, payloadJson: { runId: run.id, periodId, amount: posting.amount,
          scheduleId: posting.scheduleId, journalId: reversal.reversalJournalId }, createdBy: actorUserId, client });
    }
    await writeAudit({ organizationId: orgId, actorUserId, action: 'reverse', entityType: 'asset_depreciation_run', entityId: run.id,
      before: { status: 'posted', journalId: run.journal_entry_id }, after: { status: 'reversed', journalId: reversal.reversalJournalId }, client });
    await client.query('COMMIT');
    return { status: 'reversed', runId: run.id, journalId: reversal.reversalJournalId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

module.exports = {
  createSchedule, listSchedules, getSchedule, updateSchedule, deleteSchedule,
  listDepreciationRuns, previewPeriodEndDepreciation, runPeriodEndDepreciation, reversePeriodEndDepreciation,
};
