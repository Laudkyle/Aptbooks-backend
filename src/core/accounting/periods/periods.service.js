const { pool } = require("../../../db/pool"); 
const { enqueueEvent } = require("../../../modules/webhooks/webhooks.service"); 
const { AppError } = require("../../../shared/errors/AppError"); 

// Optional: accruals module might not exist yet in some setups
let accrualSvc = null; 
try {
  accrualSvc = require("../accruals/accruals.service"); 
} catch (_) {
  accrualSvc = null; 
}


async function closePreview({ orgId, periodId }) {
  const { rows: periodRows } = await pool.query(
    `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  ); 
  if (!periodRows.length) throw new AppError(404, "Period not found"); 
  const period = periodRows[0]; 

  // Draft journals blocking close
  const { rows: draftCount } = await pool.query(
    `
    SELECT COUNT(*)::int AS n
    FROM journal_entries
    WHERE organization_id=$1 AND period_id=$2 AND status='draft'
    `,
    [orgId, periodId]
  ); 

  // Accrual checks (if installed)
  let missingRequired = []; 
  let failedAccrualRunsCount = 0; 

  if (accrualSvc) {
    const { rows: missing } = await pool.query(
      `
      SELECT r.id, r.code, r.name
      FROM accrual_rules r
      WHERE r.organization_id=$1
        AND r.status='active'
        AND r.frequency='PERIOD_END'
        AND r.is_required=TRUE
        AND NOT EXISTS (
          SELECT 1
          FROM accrual_runs ar
          WHERE ar.organization_id=$1
            AND ar.accrual_rule_id=r.id
            AND ar.period_id=$2
            AND ar.status IN ('posted','reversed')
        )
      ORDER BY r.code
      `,
      [orgId, periodId]
    ); 
    missingRequired = missing; 

    const { rows: failed } = await pool.query(
      `
      SELECT COUNT(*)::int AS n
      FROM accrual_runs
      WHERE organization_id=$1 AND period_id=$2 AND status='failed'
      `,
      [orgId, periodId]
    ); 
    failedAccrualRunsCount = failed[0].n; 
  }

  const blockers = []; 

  if (period.status !== "open") blockers.push({ code: "period_not_open", message: `Period status is '${period.status}', must be 'open'` }); 
  if (draftCount[0].n > 0) blockers.push({ code: "draft_journals_exist", message: `${draftCount[0].n} draft journal(s) exist in this period` }); 
  if (missingRequired.length > 0) blockers.push({ code: "missing_required_accruals", message: `Missing required period-end accruals: ${missingRequired.map(x => x.code).join(", ")}` }); 
  if (failedAccrualRunsCount > 0) blockers.push({ code: "failed_accrual_runs", message: `${failedAccrualRunsCount} accrual run(s) failed for this period` }); 

  return {
    period: {
      id: period.id,
      code: period.code,
      start_date: period.start_date,
      end_date: period.end_date,
      status: period.status
    },
    accrualsInstalled: Boolean(accrualSvc),
    checks: {
      draftJournalsCount: draftCount[0].n,
      missingRequiredAccruals: missingRequired,
      failedAccrualRunsCount
    },
    canClose: blockers.length === 0,
    blockers
  }; 
}

async function createPeriod({ orgId, payload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO accounting_periods (organization_id, code, start_date, end_date, status)
    VALUES ($1,$2,$3,$4,'open')
    RETURNING id, code, start_date, end_date, status
    `,
    [orgId, payload.code, payload.startDate, payload.endDate]
  ); 
  return rows[0]; 
}

async function listPeriods({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM accounting_periods WHERE organization_id=$1 ORDER BY start_date`,
    [orgId]
  ); 
  return rows; 
}

// Current period is defined as an OPEN period that covers today (CURRENT_DATE).
// If none covers today, return the most recent OPEN period.
async function getCurrentPeriod({ orgId }) {
  const { rows: covering } = await pool.query(
    `
    SELECT id, code, start_date, end_date, status
    FROM accounting_periods
    WHERE organization_id=$1
      AND status='open'
      AND start_date <= CURRENT_DATE
      AND end_date >= CURRENT_DATE
    ORDER BY start_date DESC
    LIMIT 1
    `,
    [orgId]
  ); 
  if (covering.length) return covering[0]; 

  const { rows: latestOpen } = await pool.query(
    `
    SELECT id, code, start_date, end_date, status
    FROM accounting_periods
    WHERE organization_id=$1 AND status='open'
    ORDER BY start_date DESC
    LIMIT 1
    `,
    [orgId]
  ); 
  if (latestOpen.length) return latestOpen[0]; 

  throw new AppError(404, "No open accounting period found"); 
}

/**
 * Close period with kernel-grade guards:
 * - period must be open
 * - no draft journals in the period
 * - (if accruals module installed) required period-end accruals posted + no failed runs
 *
 * options:
 * - autoRunAccruals: boolean (default true) -> run PERIOD_END accruals before checking
 */
async function closePeriod({ orgId, periodId, actorUserId, options = {} }) {
  const autoRunAccruals = options.autoRunAccruals !== false; 

  // B3: operator override (requires permission in routes)
  const forceClose = options.force === true; 

  // B2: treat reversed as completion? default true (recommended)
  const acceptReversedAsComplete = options.acceptReversedAsComplete !== false; 

  const client = await pool.connect(); 
  try {
    await client.query("BEGIN"); 

    // Lock the period row to avoid concurrent close/reopen races
    const { rows: beforeRows } = await client.query(
      `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, periodId]
    ); 
    if (!beforeRows.length) throw new AppError(404, "Period not found"); 
    const period = beforeRows[0]; 

    if (period.status !== "open") throw new AppError(409, "Period must be open to close"); 

    // 1) Block close if draft journals exist for the period
    const { rows: draftCount } = await client.query(
      `
      SELECT COUNT(*)::int AS n
      FROM journal_entries
      WHERE organization_id=$1 AND period_id=$2 AND status='draft'
      `,
      [orgId, periodId]
    ); 
    if (draftCount[0].n > 0 && !forceClose) {
      throw new AppError(409, `Cannot close: ${draftCount[0].n} draft journal(s) exist in this period`); 
    }

    // 2) Accrual enforcement (only if accrual subsystem installed)
    // If accrualSvc is not wired, skip checks entirely.
    if (typeof accrualSvc !== "undefined" && accrualSvc) {
      // If enabled, run period-end accruals first (outside current transaction)
      // because accrualSvc will do its own tx and post journals.
      if (autoRunAccruals && !forceClose) {
        await client.query("COMMIT"); 
        await accrualSvc.runPeriodEndAccruals({
          orgId,
          actorUserId,
          periodId,
          asOfDateOverride: period.end_date
        }); 
        await client.query("BEGIN"); 

        // Re-lock the period row after reacquiring the transaction
        const { rows: relock } = await client.query(
          `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
          [orgId, periodId]
        ); 
        if (!relock.length) throw new AppError(404, "Period not found"); 
      }

      // -----------------------------
      // B1+B2: Required PERIOD_END rules must have posted runs for this period
      // -----------------------------
      const completionStatuses = acceptReversedAsComplete ? ["posted", "reversed"] : ["posted"]; 

      const { rows: missingRequired } = await client.query(
        `
        SELECT r.id, r.code, r.name
        FROM accrual_rules r
        WHERE r.organization_id=$1
          AND r.status='active'
          AND r.frequency='PERIOD_END'
          AND r.is_required=TRUE
          AND NOT EXISTS (
            SELECT 1
            FROM accrual_runs ar
            WHERE ar.organization_id=$1
              AND ar.accrual_rule_id=r.id
              AND ar.period_id=$2
              AND ar.status = ANY($3::text[])
          )
        ORDER BY r.code
        `,
        [orgId, periodId, completionStatuses]
      ); 

      if (missingRequired.length && !forceClose) {
        const msg =
          "Cannot close: required period-end accruals not posted"; 
        const err = new AppError(409, msg); 

        // attach details for client/UI
        err.details = {
          periodId,
          missingRequired: missingRequired.map((x) => ({
            id: x.id,
            code: x.code,
            name: x.name
          }))
        }; 
        throw err; 
      }

      // 2b) Any failed accrual runs for this period block close (unless force)
      const { rows: failedRuns } = await client.query(
        `
        SELECT COUNT(*)::int AS n
        FROM accrual_runs
        WHERE organization_id=$1 AND period_id=$2 AND status='failed'
        `,
        [orgId, periodId]
      ); 
      if (failedRuns[0].n > 0 && !forceClose) {
        throw new AppError(409, `Cannot close: ${failedRuns[0].n} accrual run(s) failed for this period`); 
      }

         }

    // 3) Close the period
    const { rows: afterRows } = await client.query(
      `
      UPDATE accounting_periods
      SET status='closed', updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
      `,
      [orgId, periodId]
    ); 

    await client.query("COMMIT"); 

    return {
      id: periodId,
      before: period,
      after: afterRows[0]
    }; 
  } catch (e) {
    await client.query("ROLLBACK"); 
    throw e; 
  } finally {
    client.release(); 
  }
}
async function reopenPeriod({ orgId, periodId }) {
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  ); 
  if (!beforeRows.length) throw new AppError(404, "Period not found"); 
  if (beforeRows[0].status !== "closed") throw new AppError(409, "Period must be closed to reopen"); 

  const { rows: afterRows } = await pool.query(
    `
    UPDATE accounting_periods
    SET status='open', updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, periodId]
  ); 

  return { id: periodId, before: beforeRows[0], after: afterRows[0] }; 
}

async function lockPeriod({ orgId, periodId }) {
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  ); 
  if (!beforeRows.length) throw new AppError(404, "Period not found"); 
  const before = beforeRows[0]; 
  if (before.status !== "open") throw new AppError(409, "Only open periods can be locked"); 

  const { rows: afterRows } = await pool.query(
    `UPDATE accounting_periods SET status='locked', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, periodId]
  ); 

  return { id: periodId, before, after: afterRows[0] }; 
}

async function unlockPeriod({ orgId, periodId }) {
  const { rows: beforeRows } = await pool.query(
    `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  ); 
  if (!beforeRows.length) throw new AppError(404, "Period not found"); 
  const before = beforeRows[0]; 
  if (before.status !== "locked") throw new AppError(409, "Only locked periods can be unlocked"); 

  const { rows: afterRows } = await pool.query(
    `UPDATE accounting_periods SET status='open', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, periodId]
  ); 

  return { id: periodId, before, after: afterRows[0] }; 
}

// Roll forward: create a new OPEN period after an existing period.
// If payload not provided, it will create a period with the same length as the source.
async function rollForward({ orgId, periodId, payload = {} }) {
  const { rows: srcRows } = await pool.query(
    `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  ); 
  if (!srcRows.length) throw new AppError(404, "Period not found"); 
  const src = srcRows[0]; 

  const startDate = payload.startDate || new Date(new Date(src.end_date).getTime() + 24 * 60 * 60 * 1000); 
  const lengthDays = Math.round((new Date(src.end_date) - new Date(src.start_date)) / (24 * 60 * 60 * 1000)); 
  const endDate = payload.endDate || new Date(new Date(startDate).getTime() + lengthDays * 24 * 60 * 60 * 1000); 

  const iso = (d) => {
    const dt = new Date(d); 
    const yyyy = dt.getUTCFullYear(); 
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0"); 
    const dd = String(dt.getUTCDate()).padStart(2, "0"); 
    return `${yyyy}-${mm}-${dd}`; 
  }; 

  const code = payload.code || `${src.code}_NEXT_${iso(startDate)}`; 

  const { rows } = await pool.query(
    `
    INSERT INTO accounting_periods (organization_id, code, start_date, end_date, status)
    VALUES ($1,$2,$3,$4,'open')
    RETURNING id, code, start_date, end_date, status
    `,
    [orgId, code, payload.startDate || iso(startDate), payload.endDate || iso(endDate)]
  ); 
  return rows[0]; 
}


module.exports = {
  createPeriod,
  listPeriods,
  getCurrentPeriod,
  closePeriod,
  reopenPeriod,
  closePreview,
  lockPeriod,
  unlockPeriod,
  rollForward
}; 
