const { pool } = require("../../db/pool");
const { bindTenant } = require("../../shared/security/tenantContext");
const ifrs15 = require("../../compliance/ifrs15/ifrs15.service");
const { getSystemActorUserId } = require("../../core/foundation/users/systemActor.service");

function yyyyMmDdUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * IFRS15 automation (daily):
 *  - For each organisation, find open periods ending today.
 *  - For each ACTIVE contract:
 *      - Ensure revenue schedule exists (generate if missing)
 *      - Post revenue for each qualifying period idempotently.
 */
async function ifrs15AutoPostRevenueDaily() {
  const today = yyyyMmDdUTC(new Date());

  const { rows: orgs } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);

  let posted = 0;
  let schedulesGenerated = 0;
  let skipped = 0;
  const reasons = {};

  for (const o of orgs) {
    bindTenant(o.id);
    const actorUserId = await getSystemActorUserId({ orgId: o.id });

    // only run when an open period ends today (matches common accounting close rhythm)
    const { rows: periods } = await pool.query(
      `SELECT id, end_date FROM accounting_periods WHERE organization_id=$1 AND status='open' AND end_date=$2`,
      [o.id, today]
    );
    if (!periods.length) continue;

    // settings required for posting; skip org if missing
    let settings;
    try {
      settings = await ifrs15.getSettings({ orgId: o.id });
      if (!settings?.revenue_account_id) {
        skipped += periods.length;
        reasons.missing_settings = (reasons.missing_settings || 0) + 1;
        continue;
      }
    } catch (e) {
      skipped += periods.length;
      reasons.settings_failed = (reasons.settings_failed || 0) + 1;
      continue;
    }

    const { rows: contracts } = await pool.query(
      `SELECT id FROM ifrs15_contracts WHERE organization_id=$1 AND status='active' ORDER BY created_at ASC`,
      [o.id]
    );

    for (const p of periods) {
      for (const c of contracts) {
        try {
          // ensure at least one schedule line exists
          const { rows: hasSched } = await pool.query(
            `SELECT 1 FROM ifrs15_recognition_schedule_lines WHERE organization_id=$1 AND contract_id=$2 LIMIT 1`,
            [o.id, c.id]
          );
          if (!hasSched.length) {
            await ifrs15.generateSchedule({
              orgId: o.id,
              actorUserId,
              contractId: c.id,
              payload: { contractId: c.id, replace: false }
            });
            schedulesGenerated++;
          }

          await ifrs15.postRevenueForPeriod({
            orgId: o.id,
            actorUserId,
            contractId: c.id,
            payload: {
              period_id: p.id,
              entry_date: today,
              memo: "Auto revenue posting (scheduler)"
            }
          });
          posted++;
        } catch (e) {
          skipped++;
          reasons.post_failed = (reasons.post_failed || 0) + 1;
        }
      }
    }
  }

  const extra = Object.keys(reasons).length ? ` Reasons: ${JSON.stringify(reasons)}` : "";
  return {
    message: `IFRS15 auto-post revenue for periods ending ${today}: posted=${posted}, schedulesGenerated=${schedulesGenerated}, skipped=${skipped}.${extra}`
  };
}

module.exports = { ifrs15AutoPostRevenueDaily };
