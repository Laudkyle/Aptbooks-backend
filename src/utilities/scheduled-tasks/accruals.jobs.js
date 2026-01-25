const { pool } = require("../../db/pool");
const accrualIF = require("../../interfaces/accruals.interface");
const periodIF = require("../../interfaces/periodManagement.interface");
const {  getSystemActorUserId } = require("../../core/foundation/users/systemActor.service");


function yyyyMmDdUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}


async function runDueAccrualsDaily() {
  // global runner: loop all orgs (free and simple)
  const { rows: orgs } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);
  const asOfDate = yyyyMmDdUTC(new Date());

  let ran = 0;
  for (const o of orgs) {
    const actorUserId = await  getSystemActorUserId({ orgId: o.id });
    if (!actorUserId) continue;
    const out = await accrualIF.runDueAccruals({ orgId: o.id, actorUserId, asOfDate });
    ran += Array.isArray(out) ? out.length : 0;
  }

  return { message: `Ran due accruals for ${orgs.length} org(s) @ ${asOfDate}. Posted/processed: ${ran}` };
}

async function runPeriodEndAccruals() {
  const { rows: orgs } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);
  const today = yyyyMmDdUTC(new Date());

  let ran = 0;
  for (const o of orgs) {
    const actorUserId = await  getSystemActorUserId({ orgId: o.id });
    if (!actorUserId) continue;

    // find open periods ending today
    const { rows: periods } = await pool.query(
      `
      SELECT id FROM accounting_periods
      WHERE organization_id=$1 AND status='open' AND end_date=$2
      `,
      [o.id, today]
    );

    for (const p of periods) {
      const out = await accrualIF.runPeriodEndAccruals({ orgId: o.id, actorUserId, periodId: p.id });
      ran += Array.isArray(out) ? out.length : 0;
    }
  }

  return { message: `Ran period-end accruals for period(s) ending ${today}. Posted/processed: ${ran}` };
}

async function runReversalsDaily() {
  const { rows: orgs } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);
  const today = yyyyMmDdUTC(new Date());

  let ran = 0;
  for (const o of orgs) {
    const actorUserId = await  getSystemActorUserId({ orgId: o.id });
    if (!actorUserId) continue;

    // Find open period for today
    const period = await periodIF.findOpenPeriodForDate({ orgId: o.id, date: today });
    if (!period?.id) continue;

    const out = await accrualIF.runReversals({ orgId: o.id, actorUserId, periodId: period.id });
    ran += (out?.reversedCount || 0);
  }

  return { message: `Ran reversals for ${orgs.length} org(s) @ ${today}. Reversed: ${ran}` };
}

module.exports = {
  runDueAccrualsDaily,
  runPeriodEndAccruals,
  runReversalsDaily
};
