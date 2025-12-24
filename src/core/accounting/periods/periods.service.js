const { pool } = require("../../../db/pool");
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
    // (Assumes journal_entries has 'status' with 'draft'/'posted' etc.)
    const { rows: draftCount } = await client.query(
      `
      SELECT COUNT(*)::int AS n
      FROM journal_entries
      WHERE organization_id=$1 AND period_id=$2 AND status='draft'
      `,
      [orgId, periodId]
    );
    if (draftCount[0].n > 0) {
      throw new AppError(409, `Cannot close: ${draftCount[0].n} draft journal(s) exist in this period`);
    }

    // 2) Accrual enforcement (only if accrual subsystem installed)
    if (accrualSvc) {
      // If enabled, run period-end accruals first (outside current transaction)
      // Because accrualSvc will do its own tx and post journals.
      if (autoRunAccruals) {
        await client.query("COMMIT");
        await accrualSvc.runPeriodEndAccruals({
          orgId,
          actorUserId,
          periodId,
          asOfDateOverride: period.end_date
        });
        await client.query("BEGIN");
      }

      // 2a) Missing required PERIOD_END accruals
      // Uses your schema: status, frequency, is_required
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
              AND ar.status IN ('posted','reversed')
          )
        ORDER BY r.code
        `,
        [orgId, periodId]
      );

      if (missingRequired.length) {
        const list = missingRequired.map((x) => x.code).join(", ");
        throw new AppError(409, `Cannot close: required period-end accruals not posted (${list})`);
      }

      // 2b) Any failed accrual runs for this period
      const { rows: failedRuns } = await client.query(
        `
        SELECT COUNT(*)::int AS n
        FROM accrual_runs
        WHERE organization_id=$1 AND period_id=$2 AND status='failed'
        `,
        [orgId, periodId]
      );
      if (failedRuns[0].n > 0) {
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
    return { id: periodId, before: period, after: afterRows[0] };
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


module.exports = { createPeriod, listPeriods, closePeriod, reopenPeriod,closePreview };
