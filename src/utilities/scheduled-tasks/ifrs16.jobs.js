const { pool } = require("../../db/pool");
const logger = require("../../config/logger");
const ifrs16 = require("../../compliance/ifrs16/ifrs16.service");

function isoDate(d) {
  return new Date(d).toISOString().split("T")[0];
}

/**
 * IFRS 16 automation policy:
 * - IFRS does not mandate application "scheduled_tasks" per lease.
 * - We implement one global task that scans due schedule lines and posts journals.
 */
async function postDueLeaseSchedulesDaily() {
  const today = isoDate(new Date());

  // Find active leases that have due lines up to today with any unposted journals
  const { rows: leases } = await pool.query(
    `
    SELECT DISTINCT l.id AS lease_id, l.organization_id AS org_id
    FROM leases l
    JOIN lease_schedule_lines s ON s.lease_id = l.id
    WHERE l.status = 'active'
      AND s.due_date <= $1::date
      AND (
        s.posted_interest_payment_journal_id IS NULL
        OR s.posted_depreciation_journal_id IS NULL
      )
    ORDER BY l.organization_id, l.id
    `,
    [today]
  );

  if (!leases.length) {
    return { skipped: true, message: "No due IFRS16 lease schedule lines to post" };
  }

  let postedLeases = 0;
  let postedLines = 0;

  for (const row of leases) {
    const orgId = row.org_id;
    const leaseId = row.lease_id;

    // Compute the earliest due date that still has something unposted (per lease)
    const { rows: r } = await pool.query(
      `
      SELECT MIN(due_date) AS min_due
      FROM lease_schedule_lines
      WHERE lease_id=$1
        AND due_date <= $2::date
        AND (
          posted_interest_payment_journal_id IS NULL
          OR posted_depreciation_journal_id IS NULL
        )
      `,
      [leaseId, today]
    );

    const fromDate = r[0]?.min_due ? isoDate(r[0].min_due) : null;
    if (!fromDate) continue;

    try {
      const res = await ifrs16.postLeasePeriod({
        orgId,
        actorUserId: null,
        leaseId,
        payload: {
          from_date: fromDate,
          to_date: today,
          post_interest_and_payment: true,
          post_depreciation: true,
        },
      });

      // res.posted counts "journals" not schedule lines; still useful.
      postedLeases += 1;
      postedLines += Number(res?.posted || 0);
    } catch (e) {
      // Continue scanning other leases; scheduler will record failed run details.
      logger.error(
        { err: e, orgId, leaseId },
        "IFRS16 scheduled posting failed for lease"
      );
      throw e;
    }
  }

  return { message: `Posted IFRS16 lease journals for ${postedLeases} lease(s). Journals posted: ${postedLines}.` };
}

module.exports = {
  postDueLeaseSchedulesDaily,
};
