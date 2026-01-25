const { pool } = require("../../../db/pool"); 
const { AppError } = require("../../../shared/errors/AppError"); 
const journalIF = require("../../../interfaces/journalPosting.interface"); 
const repo = require("./depreciation.repository"); 

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100; 
}

function sumMoney(lines) {
  const debit = round2(lines.reduce((s, l) => s + Number(l.debit || 0), 0)); 
  const credit = round2(lines.reduce((s, l) => s + Number(l.credit || 0), 0)); 
  return { debit, credit }; 
}


async function assertPeriodOpen(orgId, periodId) {
  const { rows } = await pool.query(
    `SELECT id, status, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  ); 
  if (!rows.length) throw new AppError(400, "Invalid periodId"); 
  if (rows[0].status !== "open") throw new AppError(409, "Period is not open"); 
  return rows[0]; 
}

async function createSchedule({ orgId, actorUserId, payload }) {
  const { rows: aRows } = await pool.query(
    `SELECT id, status FROM fixed_assets WHERE organization_id=$1 AND id=$2`,
    [orgId, payload.assetId]
  ); 
  if (!aRows.length) throw new AppError(400, "Invalid assetId"); 
  if (aRows[0].status !== "active") throw new AppError(409, "Asset is not active"); 
  return repo.createSchedule({ orgId, payload }); 
}

async function listSchedules({ orgId, query }) {
  return repo.listSchedules({ orgId, query }); 
}

async function getSchedule({ orgId, scheduleId }) {
  const s = await repo.getSchedule({ orgId, scheduleId }); 
  if (!s) throw new AppError(404, "Schedule not found"); 
  return s; 
}

async function updateSchedule({ orgId, actorUserId, scheduleId, payload }) {
  const before = await repo.getSchedule({ orgId, scheduleId }); 
  if (!before) throw new AppError(404, "Schedule not found"); 

  // Prevent editing schedules that already have postings, except status->inactive.
  const hasPostings = await repo.hasPostings({ orgId, scheduleId }); 
  const onlyStatusChange = Object.keys(payload).every((k) => k === "status"); 
  if (hasPostings && !onlyStatusChange) {
    throw new AppError(409, "Cannot edit schedule fields after postings exist;  deactivate and create a new schedule"); 
  }

  const updated = await repo.updateSchedule({ orgId, scheduleId, payload }); 
  return { before, schedule: updated }; 
}

async function deleteSchedule({ orgId, actorUserId, scheduleId }) {
  const before = await repo.getSchedule({ orgId, scheduleId }); 
  if (!before) throw new AppError(404, "Schedule not found"); 
  const hasPostings = await repo.hasPostings({ orgId, scheduleId }); 
  if (hasPostings) throw new AppError(409, "Cannot delete schedule once postings exist"); 
  await repo.deleteSchedule({ orgId, scheduleId }); 
  return { deleted: true, id: scheduleId }; 
}

async function computePeriodDepreciation({ orgId, periodId }) {
  const period = await assertPeriodOpen(orgId, periodId); 

  const { rows: schedRows } = await pool.query(
    `
    SELECT
      a.id AS asset_id,
      a.code AS asset_code,
      a.name AS asset_name,
      a.cost,
      a.salvage_value,
      s.id AS schedule_id,
      s.useful_life_months,
      s.component_code,
      s.effective_start_date,
      s.effective_end_date,
      c.depr_expense_account_id,
      c.accum_depr_account_id
    FROM asset_depreciation_schedules s
    JOIN fixed_assets a ON a.id = s.asset_id
    JOIN asset_categories c ON c.id = a.category_id
    WHERE s.organization_id=$1
      AND s.status='active'
      AND a.status='active'
      AND (a.disposed_date IS NULL AND a.disposed_at IS NULL)
      AND (s.effective_start_date <= $3::date)
      AND (s.effective_end_date IS NULL OR s.effective_end_date >= $2::date)
    ORDER BY a.code ASC, COALESCE(s.component_code,'') ASC, s.effective_start_date ASC
    `,
    [orgId, period.start_date, period.end_date]
  ); 

  const postings = []; 
  for (const r of schedRows) {
    const cost = Number(r.cost || 0); 
    const salvage = Number(r.salvage_value || 0); 
    const base = round2(cost - salvage); 
    if (base <= 0) continue; 

    const life = Number(r.useful_life_months || 0); 
    if (!(life > 0)) continue; 

    const { rows: depSum } = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS amt FROM asset_depreciation_transactions WHERE organization_id=$1 AND schedule_id=$2`,
      [orgId, r.schedule_id]
    ); 
    const accumulated = Number(depSum[0].amt || 0); 
    const remaining = round2(base - accumulated); 
    if (remaining <= 0) continue; 

    const scheduled = round2(base / life); 
    const amount = round2(Math.min(scheduled, remaining)); 
    if (amount <= 0) continue; 

    if (!r.depr_expense_account_id) throw new AppError(409, `Category missing depr_expense_account_id for asset ${r.asset_code}`); 
    if (!r.accum_depr_account_id) throw new AppError(409, `Category missing accum_depr_account_id for asset ${r.asset_code}`); 

    const component = r.component_code ? ` (${r.component_code})` : ""; 
    postings.push({
      assetId: r.asset_id,
      scheduleId: r.schedule_id,
      amount,
      expenseAccountId: r.depr_expense_account_id,
      accumAccountId: r.accum_depr_account_id,
      memo: `Depreciation: ${r.asset_name}${component}`,
    }); 
  }

  const journalLines = []; 
  for (const p of postings) {
    journalLines.push({ accountId: p.expenseAccountId, debit: p.amount, credit: 0, description: p.memo }); 
    journalLines.push({ accountId: p.accumAccountId, debit: 0, credit: p.amount, description: p.memo }); 
  }

  return { period, postings, journalLines, totals: sumMoney(journalLines) }; 
}

async function previewPeriodEndDepreciation({ orgId, periodId }) {
  const { period, postings, journalLines, totals } = await computePeriodDepreciation({ orgId, periodId }); 
  return { periodId: period.id, periodEndDate: period.end_date, postings, journalLines, totals, count: postings.length }; 
}

async function runPeriodEndDepreciation({ orgId, actorUserId, periodId }) {
  const period = await assertPeriodOpen(orgId, periodId); 

  // Lock to avoid double-runs
  const lockClient = await pool.connect(); 
  try {
    await lockClient.query("BEGIN"); 
    await lockClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`depr:${orgId}:${periodId}`]); 

    const existing = await repo.getRunByPeriod({ orgId, periodId, client: lockClient }); 
    if (existing) {
      await lockClient.query("COMMIT"); 
      return { status: "skipped", reason: "already_ran_for_period", run: existing }; 
    }

    const run = await repo.createRun({ orgId, periodId, actorUserId, client: lockClient }); 
    await lockClient.query("COMMIT"); 

    const { postings, journalLines, totals } = await computePeriodDepreciation({ orgId, periodId }); 
    if (!postings.length) {
      await repo.markRun({ orgId, runId: run.id, status: "skipped", client: undefined }); 
      return { status: "skipped", runId: run.id, reason: "no_eligible_assets" }; 
    }
    if (totals.debit !== totals.credit) {
      await repo.markRun({ orgId, runId: run.id, status: "failed", error: "Depreciation journal not balanced" }); 
      throw new AppError(500, "Depreciation journal not balanced"); 
    }

    const idempotencyKey = `depr:${orgId}:${periodId}`; 
    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      payload: {
        periodId,
        entryDate: period.end_date,
        typeCode: "ADJUSTMENT",
        memo: `Period depreciation (${periodId})`,
        idempotencyKey,
        lines: journalLines,
      },
    }); 
    const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId }); 

    const persistClient = await pool.connect(); 
    try {
      await persistClient.query("BEGIN"); 
      await repo.linkRunPosting({ runId: run.id, journalId: posted.journalId, client: persistClient }); 
      await repo.insertDepreciationTransactions({ orgId, periodId, postings, client: persistClient }); 
      await repo.markRun({ orgId, runId: run.id, status: "posted", client: persistClient }); 
      await persistClient.query("COMMIT"); 
    } catch (e) {
      await persistClient.query("ROLLBACK"); 
      await repo.markRun({ orgId, runId: run.id, status: "failed", error: `posted_but_persist_failed: ${String(e.message || e)}` }); 
      throw e; 
    } finally {
      persistClient.release(); 
    }

    return { status: "posted", runId: run.id, journalId: posted.journalId, count: postings.length }; 
  } catch (e) {
    try { await lockClient.query("ROLLBACK");  } catch (_) {}
    throw e; 
  } finally {
    lockClient.release(); 
  }
}

async function reversePeriodEndDepreciation({ orgId, actorUserId, periodId, entryDate, memo }) {
  // Reversal creates an opposite journal for the period's depreciation transactions.
  const period = await assertPeriodOpen(orgId, periodId); 

  const { rows: txns } = await pool.query(
    `
    SELECT t.asset_id, t.schedule_id, t.amount,
           c.depr_expense_account_id, c.accum_depr_account_id,
           a.code AS asset_code, a.name AS asset_name,
           s.component_code
    FROM asset_depreciation_transactions t
    JOIN asset_depreciation_schedules s ON s.id=t.schedule_id
    JOIN fixed_assets a ON a.id=t.asset_id
    JOIN asset_categories c ON c.id=a.category_id
    WHERE t.organization_id=$1 AND t.period_id=$2
    `,
    [orgId, periodId]
  ); 
  if (!txns.length) throw new AppError(409, "No depreciation transactions found for period"); 

  const lines = []; 
  for (const r of txns) {
    const amt = Number(r.amount || 0); 
    if (amt === 0) continue; 
    const component = r.component_code ? ` (${r.component_code})` : ""; 
    const desc = `Depreciation reversal: ${r.asset_name}${component}`; 
    // Reverse original: Credit expense, Debit accum
    lines.push({ accountId: r.depr_expense_account_id, debit: 0, credit: amt, description: desc }); 
    lines.push({ accountId: r.accum_depr_account_id, debit: amt, credit: 0, description: desc }); 
  }
  const totals = sumMoney(lines); 
  if (totals.debit !== totals.credit) throw new AppError(500, "Reversal journal not balanced"); 

  const idempotencyKey = `depr-rev:${orgId}:${periodId}`; 
  const draft = await journalIF.createDraftJournal({
    orgId,
    actorUserId,
    payload: {
      periodId,
      entryDate: entryDate || period.end_date,
      typeCode: "ADJUSTMENT",
      memo: memo || `Depreciation reversal (${periodId})`,
      idempotencyKey,
      lines,
    },
  }); 
  const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId }); 

  // Insert negative depreciation transactions to keep schedule balances consistent.
  const client = await pool.connect(); 
  try {
    await client.query("BEGIN"); 
    for (const r of txns) {
      const amt = Number(r.amount || 0); 
      if (amt === 0) continue; 
      await client.query(
        `INSERT INTO asset_depreciation_transactions(organization_id, asset_id, schedule_id, period_id, amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [orgId, r.asset_id, r.schedule_id, periodId, -Math.abs(amt)]
      ); 
    }
    await client.query("COMMIT"); 
  } catch (e) {
    await client.query("ROLLBACK"); 
    throw e; 
  } finally {
    client.release(); 
  }

  return { status: "reversed", journalId: posted.journalId }; 
}

module.exports = {
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  previewPeriodEndDepreciation,
  runPeriodEndDepreciation,
  reversePeriodEndDepreciation,
}; 
