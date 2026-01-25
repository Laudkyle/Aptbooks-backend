const { pool } = require("../../db/pool"); 
const periodIF = require("../../interfaces/periodManagement.interface"); 
const ifrs16 = require("../../compliance/ifrs16/ifrs16.service"); 
const { getSystemActorUserId } = require("../../core/foundation/users/systemActor.service"); 

async function getBooleanSetting({ orgId, key, defaultValue = true }) {
  try {
    const { rows } = await pool.query(
      `SELECT value_json FROM system_settings WHERE organization_id=$1 AND key=$2 LIMIT 1`,
      [orgId, key]
    ); 
    if (!rows.length) return defaultValue; 
    const v = rows[0].value_json; 
    if (typeof v === "boolean") return v; 
    if (v && typeof v.enabled === "boolean") return v.enabled; 
    if (v && typeof v.value === "boolean") return v.value; 
    return defaultValue; 
  } catch {
    return defaultValue; 
  }
}

function yyyyMmDdUTC(d) {
  const y = d.getUTCFullYear(); 
  const m = String(d.getUTCMonth() + 1).padStart(2, "0"); 
  const day = String(d.getUTCDate()).padStart(2, "0"); 
  return `${y}-${m}-${day}`; 
}

/**
 * IFRS16 automation (daily):
 *  - For each organisation, find the open accounting period for "today".
 *  - For each ACTIVE lease:
 *      - Ensure schedule exists (generate if missing)
 *      - Catch-up post: post all unposted schedule lines within the OPEN period up to today.
 *
 * Modern accounting behaviour:
 *  - Nightly catch-up for missed days in the current open period.
 *  - Does NOT back-post into closed periods.
 */
async function ifrs16AutoPostDaily() {
  const today = yyyyMmDdUTC(new Date()); 

  const { rows: orgs } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`); 

  let posted = 0; 
  let schedulesGenerated = 0; 
  let skipped = 0; 
  const reasons = {}; 

  for (const o of orgs) {
    const actorUserId = await getSystemActorUserId({ orgId: o.id }); 

    const enabled = await getBooleanSetting({
      orgId: o.id,
      key: "compliance.ifrs16.autopost.enabled",
      defaultValue: true
    }); 
    if (!enabled) continue; 

    // resolve open period for today
    let period; 
    try {
      period = await periodIF.findOpenPeriodForDate({ orgId: o.id, date: today }); 
    } catch (e) {
      skipped++; 
      reasons.no_open_period = (reasons.no_open_period || 0) + 1; 
      continue; 
    }

    const { rows: leases } = await pool.query(
      `
      SELECT id
      FROM leases
      WHERE organization_id=$1 AND status='active'
      ORDER BY created_at ASC
      `,
      [o.id]
    ); 

    for (const l of leases) {
      try {
        // ensure schedule exists
        const { rows: hasSchedule } = await pool.query(
          `SELECT 1 FROM lease_schedule_lines WHERE lease_id=$1 LIMIT 1`,
          [l.id]
        ); 
        if (!hasSchedule.length) {
          await ifrs16.generateSchedule({
            orgId: o.id,
            actorUserId,
            leaseId: l.id,
            payload: { leaseId: l.id, replace: false }
          }); 
          schedulesGenerated++; 
        }

        // Catch-up post within the open period (avoid closed periods)
        const { rows: due } = await pool.query(
          `
          SELECT MIN(due_date) AS min_due
          FROM lease_schedule_lines
          WHERE lease_id=$1
            AND due_date >= $2
            AND due_date <= $3
            AND (
              posted_interest_payment_journal_id IS NULL
              OR posted_depreciation_journal_id IS NULL
            )
          `,
          [l.id, period.start_date, today]
        ); 

        const minDue = due?.[0]?.min_due ? String(due[0].min_due).slice(0, 10) : null; 
        if (!minDue) {
          // nothing to post
          continue; 
        }

        await ifrs16.postLeasePeriod({
          orgId: o.id,
          actorUserId,
          leaseId: l.id,
          payload: {
            leaseId: l.id,
            from_date: minDue,
            to_date: today,
            post_depreciation: true,
            post_interest_and_payment: true
          }
        }); 
        posted++; 
      } catch (e) {
        skipped++; 
        reasons.lease_post_failed = (reasons.lease_post_failed || 0) + 1; 
      }
    }
  }

  const extra = Object.keys(reasons).length ? ` Reasons: ${JSON.stringify(reasons)}` : ""; 
  return {
    message: `IFRS16 auto-post ${today}: posted=${posted}, schedulesGenerated=${schedulesGenerated}, skipped=${skipped}.${extra}`
  }; 
}

module.exports = { ifrs16AutoPostDaily }; 
