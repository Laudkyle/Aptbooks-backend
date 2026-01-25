const express = require("express");
const os = require("os");

const { pool } = require("../db/pool");
const { env } = require("../config/env");
const { authRequired } = require("../middleware/auth.middleware");
const { requirePermission } = require("../middleware/permission.middleware");

/**
 * Health endpoints
 *
 * - /healthz: lightweight liveness check (no DB)
 * - /readyz: readiness check (DB required)
 * - /health/system: comprehensive authenticated health report
 */

const router = express.Router();

function nowIso() {
  return new Date().toISOString();
}

function safeParseInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function dbPing() {
  const t0 = Date.now();
  await pool.query("SELECT 1 AS ok");
  return { ok: true, latency_ms: Date.now() - t0 };
}

async function tableExists(tableName) {
  const { rows } = await pool.query(
    `SELECT to_regclass($1) AS reg`,
    [tableName]
  );
  return Boolean(rows?.[0]?.reg);
}

async function moduleTableCheck() {
  // Minimal “is the module wired + migrated” checks using canonical tables.
  // (These are not functional tests;they are health indicators.)
  const modules = [
    { module: "core.foundation", required: ["organizations", "users", "roles", "permissions", "system_settings", "audit_logs"] },
    { module: "core.accounting", required: ["chart_of_accounts", "journal_entries", "journal_entry_lines", "accounting_periods", "general_ledger_balances"] },
    { module: "modules.business", required: ["business_partners"] },
    { module: "modules.transactions", required: ["invoices", "invoice_lines", "bills", "bill_lines"] },
    { module: "modules.assets", required: ["fixed_assets", "asset_depreciation_transactions"] },
    { module: "modules.inventory", required: ["inventory_items", "inventory_transactions"] },
    { module: "modules.banking", required: ["bank_accounts", "bank_statements", "bank_statement_lines", "bank_reconciliations", "bank_transactions"] },
    { module: "reporting", required: ["budgets", "budget_versions", "kpi_definitions", "financial_statements"] },
    { module: "workflow", required: ["documents", "document_types", "document_versions", "document_approvals"] },
    { module: "compliance.ifrs16", required: ["leases", "lease_schedule_lines", "lease_posting_ledger"] },
    { module: "compliance.ifrs15", required: ["ifrs15_settings", "ifrs15_contracts", "ifrs15_recognition_schedule_lines", "ifrs15_posting_ledger"] },
    { module: "compliance.ifrs9", required: ["ifrs9_settings", "ifrs9_ecl_models", "ifrs9_ecl_runs", "ifrs9_posting_ledger"] },
    // IAS 12 tables are namespaced with ias12_ prefixes in migrations.
    { module: "compliance.ias12", required: ["ias12_settings", "ias12_tax_authorities", "ias12_tax_rate_sets", "ias12_deferred_tax_runs", "ias12_deferred_tax_postings"] },
    { module: "utilities.scheduler", required: ["scheduled_tasks", "scheduled_task_runs"] }
  ];

  const results = [];
  for (const m of modules) {
    const missing = [];
    for (const t of m.required) {
      // public schema assumed
      const ok = await tableExists(t);
      if (!ok) missing.push(t);
    }
    results.push({ module: m.module, ok: missing.length === 0, missingTables: missing });
  }
  return results;
}

async function schedulerHealthSummary({ windowDays = 7, limit = 200 } = {}) {
  const days = safeParseInt(windowDays, 7);
  const lim = safeParseInt(limit, 200);
  const { rows: tasks } = await pool.query(
    `SELECT code, name, is_enabled, last_run_at, next_run_at
     FROM scheduled_tasks
     ORDER BY code
     LIMIT $1`,
    [lim]
  );

  const { rows: recentRuns } = await pool.query(
    `WITH recent AS (
        SELECT task_code, started_at, finished_at, status, message, error,
               ROW_NUMBER() OVER (PARTITION BY task_code ORDER BY started_at DESC) AS rn
        FROM scheduled_task_runs
        WHERE started_at >= NOW() - ($1 || ' days')::interval
     )
     SELECT * FROM recent WHERE rn = 1`,
    [String(days)]
  );

  const lastByCode = new Map(recentRuns.map(r => [r.task_code, r]));

  const { rows: stats } = await pool.query(
    `SELECT task_code,
            COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
            COUNT(*) FILTER (WHERE status = 'success') AS success_count,
            AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL) AS avg_duration_ms
     FROM scheduled_task_runs
     WHERE started_at >= NOW() - ($1 || ' days')::interval
     GROUP BY task_code`,
    [String(days)]
  );
  const statsByCode = new Map(stats.map(s => [s.task_code, s]));

  const enriched = tasks.map(t => {
    const last = lastByCode.get(t.code);
    const s = statsByCode.get(t.code);
    return {
      code: t.code,
      name: t.name,
      is_enabled: t.is_enabled,
      last_run_at: t.last_run_at,
      next_run_at: t.next_run_at,
      last_status: last?.status || null,
      last_started_at: last?.started_at || null,
      last_finished_at: last?.finished_at || null,
      last_message: last?.message || null,
      last_error: last?.error || null,
      window_days: days,
      window_failed_count: Number(s?.failed_count || 0),
      window_success_count: Number(s?.success_count || 0),
      window_avg_duration_ms: s?.avg_duration_ms ? Math.round(Number(s.avg_duration_ms)) : null
    };
  });

  return {
    windowDays: days,
    generatedAt: nowIso(),
    tasks: enriched
  };
}

// --- Public liveness ---
router.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "aptbooks-backend",
    env: env.NODE_ENV,
    timestamp: nowIso(),
    uptime_seconds: Math.round(process.uptime())
  });
});

// --- Public readiness (DB) ---
router.get("/readyz", async (_req, res) => {
  try {
    const db = await dbPing();
    res.json({ ok: true, service: "aptbooks-backend", db, timestamp: nowIso() });
  } catch (e) {
    res.status(503).json({ ok: false, service: "aptbooks-backend", db: { ok: false, error: e?.message || "db_error" }, timestamp: nowIso() });
  }
});

// --- Comprehensive authenticated report ---
router.get(
  "/health/system",
  authRequired,
  requirePermission("settings.read"),
  async (req, res) => {
    const t0 = Date.now();
    const checks = {
      ok: true,
      service: "aptbooks-backend",
      env: env.NODE_ENV,
      timestamp: nowIso(),
      uptime_seconds: Math.round(process.uptime()),
      host: {
        hostname: os.hostname(),
        platform: process.platform,
        node: process.version
      },
      process: {
        pid: process.pid,
        memory_rss_bytes: process.memoryUsage().rss
      },
      db: null,
      modules: [],
      scheduler: null,
      elapsed_ms: null
    };

    try {
      checks.db = await dbPing();
    } catch (e) {
      checks.ok = false;
      checks.db = { ok: false, error: e?.message || "db_error" };
    }

    try {
      checks.modules = await moduleTableCheck();
      if (checks.modules.some(m => !m.ok)) checks.ok = false;
    } catch (e) {
      checks.ok = false;
      checks.modules = [{ module: "module_table_check", ok: false, error: e?.message || "error" }];
    }

    try {
      checks.scheduler = await schedulerHealthSummary({ windowDays: 14, limit: 500 });
      // Mark unhealthy if enabled tasks are failing repeatedly in the window
      const failingEnabled = checks.scheduler.tasks.filter(t => t.is_enabled && t.window_failed_count > 0 && t.window_success_count === 0);
      if (failingEnabled.length) {
        checks.ok = false;
        checks.scheduler.summary = {
          failingEnabledTasks: failingEnabled.slice(0, 50).map(t => t.code)
        };
      }
    } catch (e) {
      checks.ok = false;
      checks.scheduler = { ok: false, error: e?.message || "scheduler_health_error" };
    }

    checks.elapsed_ms = Date.now() - t0;
    res.status(checks.ok ? 200 : 503).json(checks);
  }
);

module.exports = { healthRouter: router, schedulerHealthSummary };
