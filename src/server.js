const http = require("http");
const app = require("./app");
const { env } = require("./config/env");
const logger = require("./config/logger");

http.createServer(app).listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Server listening");
});
const { startScheduler } = require("./utilities/scheduled-tasks/scheduler");
const {
  runDueAccrualsDaily,
  runPeriodEndAccruals,
  runReversalsDaily,
} = require("./utilities/scheduled-tasks/accruals.jobs");
const { runPeriodEndDepreciationDaily } = require("./utilities/scheduled-tasks/assets.jobs");
const { computeDeferredTaxDraftDaily, checkIas12ConfigDaily } = require("./utilities/scheduled-tasks/ias12.jobs");
const { ifrs16AutoPostDaily } = require("./utilities/scheduled-tasks/ifrs16.jobs");
const { ifrs15AutoPostRevenueDaily } = require("./utilities/scheduled-tasks/ifrs15.jobs");
const { ifrs9AutoComputeAndFinalizeEclDaily } = require("./utilities/scheduled-tasks/ifrs9.jobs");
// after server starts listening:
if (process.env.SCHEDULER_ENABLED !== "false") {
  startScheduler({
    pollIntervalMs: Number(process.env.SCHEDULER_POLL_MS || 5000),
    tasks: [
      {
        code: "accruals.run_due.daily",
        name: "Run due accruals daily",
        schedule: { type: "daily_at_utc", dailyHourUtc: 1, dailyMinuteUtc: 0 },
        handler: async () => runDueAccrualsDaily(),
      },
      {
        code: "accruals.run_period_end.daily",
        name: "Run period-end accruals",
        schedule: {
          type: "daily_at_utc",
          dailyHourUtc: 23,
          dailyMinuteUtc: 50,
        },
        handler: async () => runPeriodEndAccruals(),
      },
      {
        code: "accruals.run_reversals.daily",
        name: "Run accrual reversals",
        schedule: { type: "daily_at_utc", dailyHourUtc: 0, dailyMinuteUtc: 5 },
        handler: async () => runReversalsDaily(),
      },
      {
        code: "assets.depreciation.period_end.daily",
        name: "Run period-end depreciation",
        schedule: {
          type: "daily_at_utc",
          dailyHourUtc: 23,
          dailyMinuteUtc: 40,
        },
        handler: async () => runPeriodEndDepreciationDaily(),
      },

      {
        code: "ias12.deferred_tax.compute_draft.daily",
        name: "Compute IAS12 deferred tax draft (period end)",
        schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 55 },
        handler: async () => computeDeferredTaxDraftDaily(),
      },
      {
        code: "ias12.config.check.daily",
        name: "Check IAS12 configuration",
        schedule: { type: "daily_at_utc", dailyHourUtc: 0, dailyMinuteUtc: 15 },
        handler: async () => checkIas12ConfigDaily(),
      },

      // Compliance automations
      {
        code: "ifrs16.leases.autopost.daily",
        name: "IFRS16 auto-post leases (daily)",
        schedule: { type: "daily_at_utc", dailyHourUtc: 0, dailyMinuteUtc: 25 },
        handler: async () => ifrs16AutoPostDaily(),
      },
      {
        code: "ifrs15.revenue.autopost.period_end.daily",
        name: "IFRS15 auto-post revenue (period end)",
        schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 35 },
        handler: async () => ifrs15AutoPostRevenueDaily(),
      },
      {
        code: "ifrs9.ecl.compute_finalize.period_end.daily",
        name: "IFRS9 ECL compute & finalize (period end)",
        schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 45 },
        handler: async () => ifrs9AutoComputeAndFinalizeEclDaily(),
      },
    ],
  }).catch(() => {});
}
