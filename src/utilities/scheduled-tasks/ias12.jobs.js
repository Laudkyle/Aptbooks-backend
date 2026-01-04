const { pool } = require("../../db/pool");
const periodIF = require("../../interfaces/periodManagement.interface");
const ias12 = require("../../compliance/ias12/ias12.service");
const { getSystemActorUserId } = require("../../core/foundation/users/systemActor.service");

function yyyyMmDdUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Compute a DRAFT deferred tax run for any open period ending today,
// for all organizations that have IAS12 settings + a resolvable rate set.
// Does NOT finalize or post.
async function computeDeferredTaxDraftDaily() {
  const today = yyyyMmDdUTC(new Date());
  const actorUserId = await getSystemActorUserId();

  const { rows: orgs } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);

  let computed = 0;
  let skipped = 0;
  let reasons = {};

  for (const o of orgs) {
    // find open periods ending today
    const { rows: periods } = await pool.query(
      `SELECT id FROM accounting_periods WHERE organization_id=$1 AND status='open' AND end_date=$2`,
      [o.id, today]
    );

    for (const p of periods) {
      try {
        // Ensure settings exist + rate set resolvable
        const settings = await ias12.getSettings({ orgId: o.id });
        if (!settings || !settings.default_rate_set_id) {
          skipped++;
          reasons.missing_settings = (reasons.missing_settings || 0) + 1;
          continue;
        }

        // Only compute if there is at least one temp difference line for the period
        const { rows: td } = await pool.query(
          `SELECT 1 FROM ias12_temp_differences WHERE organization_id=$1 AND period_id=$2 LIMIT 1`,
          [o.id, p.id]
        );
        if (!td.length) {
          skipped++;
          reasons.no_temp_differences = (reasons.no_temp_differences || 0) + 1;
          continue;
        }

        await ias12.computeDeferredTax({
          orgId: o.id,
          actorUserId,
          payload: { period_id: p.id, rate_set_id: settings.default_rate_set_id, memo: "Auto draft compute (scheduler)" }
        });
        computed++;
      } catch (e) {
        skipped++;
        reasons.compute_failed = (reasons.compute_failed || 0) + 1;
      }
    }
  }

  const extra = Object.keys(reasons).length ? ` Reasons: ${JSON.stringify(reasons)}` : "";
  return { message: `IAS12 draft compute for periods ending ${today}: computed=${computed}, skipped=${skipped}.${extra}` };
}

// Simple configuration check: reports orgs missing IAS12 settings or rate coverage for their open period end date.
async function checkIas12ConfigDaily() {
  const actorUserId = await getSystemActorUserId();
  const { rows: orgs } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);

  let issues = 0;

  for (const o of orgs) {
    // take the latest open period (by end_date)
    const { rows: periods } = await pool.query(
      `SELECT id, end_date FROM accounting_periods WHERE organization_id=$1 AND status='open' ORDER BY end_date DESC LIMIT 1`,
      [o.id]
    );
    if (!periods.length) continue;

    const p = periods[0];

    try {
      const settings = await ias12.getSettings({ orgId: o.id });
      if (!settings || !settings.default_rate_set_id) {
        issues++;
        continue;
      }
      // Attempt to resolve tax rate (this will throw if not covered)
      await ias12.resolveRateForPeriodEnd({ rateSetId: settings.default_rate_set_id, periodId: p.id, orgId: o.id });
    } catch (e) {
      issues++;
    }
  }

  return { message: `IAS12 config check completed. Organizations with issues: ${issues}` };
}

module.exports = { computeDeferredTaxDraftDaily, checkIas12ConfigDaily };
