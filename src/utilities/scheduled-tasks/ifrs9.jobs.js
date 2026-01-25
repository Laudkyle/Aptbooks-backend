const { pool } = require("../../db/pool");
const ifrs9 = require("../../compliance/ifrs9/ifrs9.service");
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
 * IFRS9 automation (daily):
 *  - For each organisation, find open periods ending today.
 *  - If IFRS9 settings exist and there is an active ECL model, compute an ECL run (as_of_date=today),
 *    finalize it, and (by default) post the delta impairment journal to the GL.
 *
 * Modern accounting behaviour:
 *  - Period-end ECL compute is commonly automated.
 *  - Posting can be automated, but should remain tenant-controllable. This implementation defaults
 *    to auto-post enabled;set system setting compliance.ifrs9.autopost.enabled to disable.
 *
 * Safeguards:
 *  - Do nothing if an ECL run already exists for (period, model, as_of_date).
 */
async function ifrs9AutoComputeAndFinalizeEclDaily() {
  const today = yyyyMmDdUTC(new Date());

  const { rows: orgs } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);

  let computed = 0;
  let finalized = 0;
  let posted = 0;
  let skipped = 0;
  const reasons = {};

  for (const o of orgs) {
    const actorUserId = await getSystemActorUserId({ orgId: o.id });

    const autoPostEnabled = await getBooleanSetting({
      orgId: o.id,
      key: "compliance.ifrs9.autopost.enabled",
      defaultValue: true
    });

    const { rows: periods } = await pool.query(
      `SELECT id FROM accounting_periods WHERE organization_id=$1 AND status='open' AND end_date=$2`,
      [o.id, today]
    );
    if (!periods.length) continue;

    // settings required
    let settings;
    try {
      settings = await ifrs9.getIfrs9Settings({ orgId: o.id });
      if (!settings?.loss_allowance_account_id || !settings?.impairment_expense_account_id) {
        skipped += periods.length;
        reasons.missing_settings = (reasons.missing_settings || 0) + 1;
        continue;
      }
    } catch (e) {
      skipped += periods.length;
      reasons.settings_failed = (reasons.settings_failed || 0) + 1;
      continue;
    }

    // pick an active model
    const { rows: models } = await pool.query(
      `SELECT id FROM ifrs9_ecl_models WHERE organization_id=$1 AND status='active' ORDER BY created_at ASC LIMIT 1`,
      [o.id]
    );
    if (!models.length) {
      skipped += periods.length;
      reasons.no_model = (reasons.no_model || 0) + 1;
      continue;
    }
    const modelId = models[0].id;

    for (const p of periods) {
      // Prevent duplicate runs
      const { rows: existing } = await pool.query(
        `
        SELECT id, status
        FROM ifrs9_ecl_runs
        WHERE organization_id=$1 AND period_id=$2 AND model_id=$3 AND as_of_date=$4
          AND status IN ('computed','finalized','posted')
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [o.id, p.id, modelId, today]
      );
      if (existing.length) {
        skipped++;
        reasons.already_exists = (reasons.already_exists || 0) + 1;
        continue;
      }

      try {
        const details = await ifrs9.computeEcl({
          orgId: o.id,
          actorUserId,
          payload: {
            period_id: p.id,
            model_id: modelId,
            approach: "GENERAL",
            as_of_date: today,
            memo: "Auto ECL compute (scheduler)"
          }
        });
        computed++;

        const runId = details?.run?.id;
        if (runId) {
          await ifrs9.finalizeRun({ orgId: o.id, actorUserId, runId });
          finalized++;

          if (autoPostEnabled) {
            try {
              await ifrs9.postEcl({
                orgId: o.id,
                actorUserId,
                payload: {
                  period_id: p.id,
                  run_id: runId,
                  entry_date: today,
                  memo: "Auto ECL post (scheduler)"
                }
              });
              posted++;
            } catch (e) {
              // Keep compute/finalize successful even if posting fails (common in practice when mappings change)
              reasons.post_failed = (reasons.post_failed || 0) + 1;
            }
          }
        }
      } catch (e) {
        skipped++;
        reasons.compute_failed = (reasons.compute_failed || 0) + 1;
      }
    }
  }

  const extra = Object.keys(reasons).length ? ` Reasons: ${JSON.stringify(reasons)}` : "";
  return {
    message: `IFRS9 auto ECL for periods ending ${today}: computed=${computed}, finalized=${finalized}, posted=${posted}, skipped=${skipped}.${extra}`
  };
}

module.exports = { ifrs9AutoComputeAndFinalizeEclDaily };
