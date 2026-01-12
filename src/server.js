const http = require("http");

const app = require("./app");
const logger = require("./config/logger");
const { env, validateRuntimeEnv } = require("./config/env");
const { pool } = require("./db/pool");
const { startScheduler } = require("./utilities/scheduled-tasks/scheduler");

const {
  runDueAccrualsDaily,
  runPeriodEndAccruals,
  runReversalsDaily
} = require("./utilities/scheduled-tasks/accruals.jobs");
const { runPeriodEndDepreciationDaily } = require("./utilities/scheduled-tasks/assets.jobs");
const { computeDeferredTaxDraftDaily, checkIas12ConfigDaily } = require("./utilities/scheduled-tasks/ias12.jobs");
const { ifrs16AutoPostDaily } = require("./utilities/scheduled-tasks/ifrs16.jobs");
const { ifrs15AutoPostRevenueDaily } = require("./utilities/scheduled-tasks/ifrs15.jobs");
const { ifrs9AutoComputeAndFinalizeEclDaily } = require("./utilities/scheduled-tasks/ifrs9.jobs");
const { maintenanceRetentionDaily, maintenanceRateLimitCleanupDaily } = require("./utilities/scheduled-tasks/maintenance.jobs");

function parseIntOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function waitForDb({ timeoutMs = 15000 } = {}) {
  const start = Date.now();
  // simple readiness loop (handles container start ordering)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pool.query("SELECT 1 AS ok");
      return;
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function main() {
  validateRuntimeEnv();

  // Create HTTP server explicitly so we can tune timeouts and support graceful shutdown.
  const server = http.createServer(app);

  // Production-grade timeout defaults (override via env as needed)
  // - requestTimeout: max time for the whole request
  // - headersTimeout: max time to receive headers
  // - keepAliveTimeout: keep-alive for idle connections
  server.requestTimeout = parseIntOr(process.env.HTTP_REQUEST_TIMEOUT_MS, 60_000);
  server.headersTimeout = parseIntOr(process.env.HTTP_HEADERS_TIMEOUT_MS, 65_000);
  server.keepAliveTimeout = parseIntOr(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS, 5_000);

  // Track open sockets for graceful shutdown.
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  // Ensure DB is reachable before accepting traffic if desired.
  if (process.env.WAIT_FOR_DB !== "false") {
    await waitForDb({ timeoutMs: parseIntOr(process.env.DB_WAIT_TIMEOUT_MS, 15_000) });
  }

  await new Promise((resolve) => {
    server.listen(env.PORT, () => {
      logger.info({ port: env.PORT, env: env.NODE_ENV }, "Server listening");
      resolve();
    });
  });

  // Start DB-backed scheduler (optional)
  let schedulerStop = null;
  if (process.env.SCHEDULER_ENABLED !== "false") {
    const scheduler = await startScheduler({
      pollIntervalMs: parseIntOr(process.env.SCHEDULER_POLL_MS, 5000),
      tasks: [
        // Core accounting
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
        },
        {
          code: "assets.depreciation.period_end.daily",
          name: "Run period-end depreciation",
          schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 40 },
          handler: async () => runPeriodEndDepreciationDaily()
        },

        // IAS12
        {
          code: "ias12.deferred_tax.compute_draft.daily",
          name: "Compute IAS12 deferred tax draft (period end)",
          schedule: { type: "daily_at_utc", dailyHourUtc: 23, dailyMinuteUtc: 55 },
          handler: async () => computeDeferredTaxDraftDaily()
        },
        {
          code: "ias12.config.check.daily",
          name: "Check IAS12 configuration",
          schedule: { type: "daily_at_utc", dailyHourUtc: 0, dailyMinuteUtc: 15 },
          handler: async () => checkIas12ConfigDaily()
        },

        // Compliance automations
        {
          code: "ifrs16.leases.autopost.daily",
          name: "IFRS16 auto-post leases (daily)",
          schedule: { type: "daily_at_utc", dailyHourUtc: 0, dailyMinuteUtc: 25 },
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

        // Maintenance
        {
          code: "maintenance.retention.daily",
          name: "Maintenance: retention cleanup",
          schedule: { type: "daily_at_utc", dailyHourUtc: 2, dailyMinuteUtc: 30 },
          handler: async () => maintenanceRetentionDaily()
        },
        {
          code: "maintenance.rate_limit.cleanup.daily",
          name: "Maintenance: rate limit cleanup",
          schedule: { type: "daily_at_utc", dailyHourUtc: 2, dailyMinuteUtc: 35 },
          handler: async () => maintenanceRateLimitCleanupDaily()
        }
      ]
    });
    schedulerStop = scheduler?.stop || null;
  }

  async function shutdown(signal) {
    logger.warn({ signal }, "Shutdown requested");

    try {
      if (schedulerStop) {
        await schedulerStop();
      }
    } catch (e) {
      logger.warn({ err: e?.message }, "Failed to stop scheduler cleanly");
    }

    // Stop accepting new connections.
    await new Promise((resolve) => server.close(resolve));

    // Close idle sockets; force close after timeout.
    const forceAfterMs = parseIntOr(process.env.SHUTDOWN_FORCE_AFTER_MS, 10_000);
    const t = setTimeout(() => {
      for (const s of sockets) s.destroy();
    }, forceAfterMs);
    t.unref();

    try {
      await pool.end();
    } catch (e) {
      logger.warn({ err: e?.message }, "DB pool close failed");
    }

    logger.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
    shutdown("uncaughtException");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
