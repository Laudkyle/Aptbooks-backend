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
  runReversalsDaily
} = require("./utilities/scheduled-tasks/accruals.jobs");

// after server starts listening:
if (process.env.SCHEDULER_ENABLED !== "false") {
  startScheduler({
    pollIntervalMs: Number(process.env.SCHEDULER_POLL_MS || 5000),
    tasks: [
      {
        code: "accruals.run_due.daily",
        name: "Run due accruals daily",
        schedule: { type: "daily_at_utc", dailyHourUtc: 1, dailyMinuteUtc: 0 },
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
        schedule: { type: "daily_at_utc", dailyHourUtc: 0, dailyMinuteUtc: 5 },
        handler: async () => runReversalsDaily()
      }
    ]
  }).catch(() => {});
}
