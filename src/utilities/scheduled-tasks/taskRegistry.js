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
const { runDueSavedReportSchedulesHourly } = require("./reports.jobs"); 
const {
  maintenanceRetentionDaily,
  maintenanceRateLimitCleanupDaily,
  purgeReportCacheHourly,
  purgeSavedReportRunsDaily,
} = require("./maintenance.jobs"); 

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
    },
    {
      code: "reporting.saved_reports.run_due.hourly",
      name: "Run due saved report schedules (hourly)",
      schedule: { type: "interval_seconds", intervalSeconds: 3600 },
      handler: async () => runDueSavedReportSchedulesHourly()
    },
    {
      code: "maintenance.scheduler_retention.daily",
      name: "Purge scheduler operational logs (daily)",
      schedule: { type: "daily_at_utc", dailyHourUtc: 2, dailyMinuteUtc: 0 },
      handler: async () => maintenanceRetentionDaily(),
    },
    {
      code: "maintenance.rate_limit.cleanup.daily",
      name: "Purge rate limit windows (daily)",
      schedule: { type: "daily_at_utc", dailyHourUtc: 2, dailyMinuteUtc: 10 },
      handler: async () => maintenanceRateLimitCleanupDaily(),
    },
    {
      code: "reporting.report_cache.purge.hourly",
      name: "Purge expired report cache (hourly)",
      schedule: { type: "interval_seconds", intervalSeconds: 3600 },
      handler: async () => purgeReportCacheHourly(),
    },
    {
      code: "reporting.saved_report_runs.retention.daily",
      name: "Purge saved report run history per retention (daily)",
      schedule: { type: "daily_at_utc", dailyHourUtc: 2, dailyMinuteUtc: 20 },
      handler: async () => purgeSavedReportRunsDaily(),
    }
  ]; 
}

function getTask(code) {
  return listTasks().find((t) => t.code === code) || null; 
}

module.exports = { listTasks, getTask }; 
