// Central registry for scheduled task handlers.
// Used by both the scheduler runner and admin "run now" endpoints.

const {
  runDueAccrualsDaily,
  runPeriodEndAccruals,
  runReversalsDaily,
} = require("./accruals.jobs");
const { runPeriodEndDepreciationDaily } = require("./assets.jobs");
const { computeDeferredTaxDraftDaily, checkIas12ConfigDaily } = require("./ias12.jobs");
const { ifrs16AutoPostDaily } = require("./ifrs16.jobs");
const { ifrs15AutoPostRevenueDaily } = require("./ifrs15.jobs");
const { ifrs9AutoComputeAndFinalizeEclDaily } = require("./ifrs9.jobs");

function listTasks() {
  return [
    {
      code: "accruals.run_due.daily",
      name: "Run due accruals daily",
      schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 0 },
      handler: async () => runDueAccrualsDaily()
    },
    {
      code: "accruals.run_period_end.daily",
      name: "Run period-end accruals",
      schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 50 },
      handler: async () => runPeriodEndAccruals()
    },
    {
      code: "accruals.run_reversals.daily",
      name: "Run accrual reversals",
      schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 5 },
      handler: async () => runReversalsDaily()
    },
    {
      code: "assets.depreciation.period_end.daily",
      name: "Run period-end depreciation",
      schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 40 },
      handler: async () => runPeriodEndDepreciationDaily()
    },
    {
      code: "ias12.deferred_tax.compute_draft.daily",
      name: "Compute IAS12 deferred tax draft (period end)",
      schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 55 },
      handler: async () => computeDeferredTaxDraftDaily()
    },
    {
      code: "ias12.config.check.daily",
      name: "Check IAS12 configuration",
      schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 15 },
      handler: async () => checkIas12ConfigDaily()
    },
    {
      code: "ifrs16.leases.autopost.daily",
      name: "IFRS16 auto-post leases (daily)",
      schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 25 },
      handler: async () => ifrs16AutoPostDaily()
    },
    {
      code: "ifrs15.revenue.autopost.period_end.daily",
      name: "IFRS15 auto-post revenue (period end)",
      schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 35 },
      handler: async () => ifrs15AutoPostRevenueDaily()
    },
    {
      code: "ifrs9.ecl.compute_finalize.period_end.daily",
      name: "IFRS9 ECL compute & finalize (period end)",
      schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 45 },
      handler: async () => ifrs9AutoComputeAndFinalizeEclDaily()
    }
  ];
}

function getTask(code) {
  return listTasks().find((t) => t.code === code) || null;
}

module.exports = { listTasks, getTask };
