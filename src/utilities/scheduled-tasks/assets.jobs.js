const { pool } = require("../../db/pool");
const { getSystemActorUserId } = require("../../core/foundation/users/systemActor.service");
const depreciationSvc = require("../../modules/assets/depreciation/depreciation.service");

async function runPeriodEndDepreciationDaily() {
  // Find open periods and run depreciation for each.
  // You may constrain to "current" open period;this runs safely due to idempotency.
  const { rows: orgs } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);

  for (const o of orgs) {
    const orgId = o.id;
    const actorUserId = await getSystemActorUserId({ orgId });

    const { rows: openPeriods } = await pool.query(
      `SELECT id FROM accounting_periods WHERE organization_id=$1 AND status='open' ORDER BY start_date ASC`,
      [orgId]
    );

    for (const p of openPeriods) {
      // Safe to call;(org, period) run table prevents duplicates
      await depreciationSvc.runPeriodEndDepreciation({ orgId, actorUserId, periodId: p.id });
    }
  }
}

module.exports = { runPeriodEndDepreciationDaily };
