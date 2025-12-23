/**
 * Period Management API (Tier 1)
 * - createPeriod(orgId, payload)
 * - closePeriod(orgId, periodId, actorUserId)
 * - reopenPeriod(orgId, periodId, actorUserId)  // optional
 */
module.exports = {};
/**
 * Period Management API (Tier 1)
 * Tier >= 2 modules use this to validate dates / open periods.
 */
const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

async function findOpenPeriodForDate({ orgId, date }) {
  const { rows } = await pool.query(
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

module.exports = { findOpenPeriodForDate };
