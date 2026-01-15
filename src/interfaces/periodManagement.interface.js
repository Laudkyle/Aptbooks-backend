/**
 * Period Management API (Tier 1)
 * Tier >= 2 modules and HTTP routes should use this boundary instead of
 * directly calling services/repositories.
 */
const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

const periodsSvc = require("../core/accounting/periods/periods.service");

async function findOpenPeriodForDate({ orgId, date, client = null }) {
  const db = client || pool;
  const { rows } = await db.query(
    `
    SELECT id, start_date, end_date, status
    FROM accounting_periods
    WHERE organization_id=$1
      AND status='open'
      AND $2::date BETWEEN start_date AND end_date
    ORDER BY start_date DESC
    LIMIT 1
    `,
    [orgId, date]
  );
  if (!rows.length) throw new AppError(409, "No open accounting period for date");
  return rows[0];
}

// Administrative wrappers (still Tier 1 contract)
async function createPeriod({ orgId, payload }) {
  return periodsSvc.createPeriod({ orgId, payload });
}

async function listPeriods({ orgId }) {
  return periodsSvc.listPeriods({ orgId });
}

async function getCurrentPeriod({ orgId }) {
  return periodsSvc.getCurrentPeriod({ orgId });
}

async function closePreview({ orgId, periodId }) {
  return periodsSvc.closePreview({ orgId, periodId });
}

async function closePeriod({ orgId, periodId, actorUserId, options = {} }) {
  return periodsSvc.closePeriod({ orgId, periodId, actorUserId, options });
}

async function reopenPeriod({ orgId, periodId }) {
  return periodsSvc.reopenPeriod({ orgId, periodId });
}

async function lockPeriod({ orgId, periodId, actorUserId }) {
  return periodsSvc.lockPeriod({ orgId, periodId, actorUserId });
}

async function unlockPeriod({ orgId, periodId, actorUserId }) {
  return periodsSvc.unlockPeriod({ orgId, periodId, actorUserId });
}

async function rollForward({ orgId, periodId, actorUserId, payload = {} }) {
  return periodsSvc.rollForward({ orgId, periodId, actorUserId, payload });
}

module.exports = {
  findOpenPeriodForDate,
  createPeriod,
  listPeriods,
  getCurrentPeriod,
  closePreview,
  closePeriod,
  reopenPeriod,
  lockPeriod,
  unlockPeriod,
  rollForward
};
