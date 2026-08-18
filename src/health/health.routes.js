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
 * - /health/modules: authenticated module-only health report
 * - /health/modules/:moduleKey: single module/submodule health report
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
  const { rows } = await pool.query(`SELECT to_regclass($1) AS reg`, [tableName]);
  return Boolean(rows?.[0]?.reg);
}

const MODULE_REGISTRY = [
  {
    module: "core.foundation",
    required: [
      "organizations",
      "users",
      "roles",
      "permissions",
      "role_permissions",
      "user_roles",
      "user_organizations",
      "system_settings",
      "audit_logs",
      "api_keys",
      "dimension_access_rules",
      "login_history",
      "refresh_tokens"
    ]
  },
  {
    module: "core.accounting",
    required: [
      "chart_of_accounts",
      "journal_entries",
      "journal_entry_lines",
      "journal_entry_types",
      "accounting_periods",
      "general_ledger_balances",
      "exchange_rates",
      "exchange_rate_history",
      "exchange_rate_types",
      "tax_codes",
      "tax_jurisdictions",
      "tax_settings"
    ]
  },
  {
    module: "workflow.documents",
    required: [
      "documents",
      "document_types",
      "document_versions",
      "document_approvals",
      "document_type_approval_levels",
      "document_workflow_statics",
      "workflow_states"
    ]
  },
  {
    module: "notifications",
    required: ["notifications"]
  },
  {
    module: "search",
    required: ["report_cache"]
  },
  {
    module: "modules.business",
    required: [
      "business_partners",
      "payment_terms",
      "payment_methods",
      "vendor_tax_profiles"
    ]
  },
  {
    module: "modules.transactions.invoices",
    required: ["invoices", "invoice_lines", "invoice_sequences"]
  },
  {
    module: "modules.transactions.bills",
    required: ["bills", "bill_lines"]
  },
  {
    module: "modules.transactions.receipts",
    required: [
      "customer_receipts",
      "customer_receipt_allocations",
      "customer_receipt_sequences"
    ]
  },
  {
    module: "modules.transactions.vendor_payments",
    required: [
      "vendor_payments",
      "vendor_payment_allocations",
      "vendor_payment_sequences"
    ]
  },
  {
    module: "modules.transactions.credit_notes",
    required: [
      "credit_notes",
      "credit_note_lines",
      "credit_note_applications",
      "credit_note_sequences"
    ]
  },
  {
    module: "modules.transactions.debit_notes",
    required: [
      "debit_notes",
      "debit_note_lines",
      "debit_note_applications",
      "debit_note_sequences"
    ]
  },
  {
    module: "modules.transactions.ops_documents",
    required: [
      "operational_documents",
      "operational_document_lines",
      "operational_document_sequences"
    ]
  },
  {
    module: "modules.ar.collections",
    required: [
      "dunning_templates",
      "dunning_rules",
      "dunning_runs",
      "dunning_run_items",
      "disputes",
      "writeoffs",
      "payment_plans"
    ]
  },
  {
    module: "modules.ar.disputes",
    required: ["disputes", "dispute_actions", "dispute_reason_codes"]
  },
  {
    module: "modules.ar.writeoffs",
    required: ["writeoffs", "writeoff_actions", "writeoff_reason_codes", "writeoff_settings"]
  },
  {
    module: "modules.ar.payment_plans",
    required: ["payment_plans", "payment_plan_installments"]
  },
  {
    module: "modules.assets",
    required: ["fixed_assets", "asset_depreciation_transactions", "asset_categories"]
  },
  {
    module: "modules.inventory.core",
    required: [
      "inventory_items",
      "item_categories",
      "item_units",
      "warehouses",
      "warehouse_bins",
      "inventory_balances",
      "inventory_transactions",
      "inventory_transaction_lines"
    ]
  },
  {
    module: "modules.inventory.traceability",
    required: [
      "inventory_batches",
      "inventory_serial_numbers",
      "inventory_traceability_links",
      "inventory_reservations",
      "inventory_transfer_requests",
      "inventory_transfer_request_lines",
      "inventory_reorder_settings"
    ]
  },
  {
    module: "modules.inventory.counts",
    required: ["inventory_stock_counts", "inventory_stock_count_lines"]
  },
  {
    module: "modules.banking.core",
    required: [
      "bank_accounts",
      "bank_transactions",
      "bank_statements",
      "bank_statement_lines",
      "bank_reconciliations",
      "statement_lines",
      "statement_line_accounts",
      "statement_templates"
    ]
  },
  {
    module: "modules.banking.treasury",
    required: [
      "payment_runs",
      "payment_run_lines",
      "payment_approval_batches",
      "payment_approval_batch_items",
      "cheques",
      "bank_transfers"
    ]
  },
  {
    module: "modules.automation",
    required: [
      "automation_recurring_transactions",
      "automation_recurring_transaction_runs",
      "automation_reconciliation_profiles",
      "automation_reconciliation_runs",
      "automation_document_match_profiles",
      "automation_document_match_runs",
      "automation_classification_rules",
      "automation_notification_rules"
    ]
  },
  {
    module: "modules.printing",
    required: [
      "document_templates",
      "document_template_versions",
      "document_template_assignments",
      "document_render_logs"
    ]
  },
  {
    module: "modules.integrations.payments",
    required: [
      "payment_settings",
      "payment_providers",
      "payment_intents",
      "payment_intent_links",
      "payment_webhook_events"
    ]
  },
  {
    module: "modules.integrations.core",
    required: ["integration_connections", "e_invoices", "tax_forms", "tax_form_runs", "tax_returns"]
  },
  {
    module: "modules.webhooks",
    required: ["webhook_subscriptions", "webhook_outbox"]
  },
  {
    module: "modules.hr.foundation",
    required: [
      "hr_departments",
      "hr_positions",
      "hr_grades",
      "hr_compensation_bands",
      "hr_employees"
    ]
  },
  {
    module: "modules.hr.payroll",
    required: [
      "hr_payroll_components",
      "hr_employee_pay_components",
      "hr_payroll_runs",
      "hr_payroll_run_lines",
      "hr_payroll_run_postings"
    ]
  },
  {
    module: "modules.hr.leave_benefits",
    required: [
      "hr_leave_types",
      "hr_leave_balances",
      "hr_leave_requests",
      "hr_leave_ledger",
      "hr_benefit_plans",
      "hr_employee_benefits",
      "hr_statutory_rules"
    ]
  },
  {
    module: "reporting.budgets",
    required: ["budgets", "budget_versions"]
  },
  {
    module: "reporting.forecasts",
    required: ["forecasts", "forecast_versions", "forecast_lines", "scenarios"]
  },
  {
    module: "reporting.kpis",
    required: ["kpi_definitions", "kpi_targets", "kpi_values"]
  },
  {
    module: "reporting.financial_statements",
    required: ["financial_statements", "reporting_equity_settings", "reporting_equity_mappings", "equity_movement_types"]
  },
  {
    module: "reporting.report_builder",
    required: [
      "saved_reports",
      "saved_report_versions",
      "saved_report_runs",
      "saved_report_schedules",
      "saved_report_shares",
      "saved_report_comments",
      "saved_report_document_links"
    ]
  },
  {
    module: "reporting.analytics",
    required: ["reporting_packages", "reporting_package_items", "analytics_snapshots"]
  },
  {
    module: "reporting.allocations",
    required: ["allocation_sets", "allocation_rules", "allocation_runs"]
  },
  {
    module: "reporting.dimensions",
    required: [
      "cost_centers",
      "profit_centers",
      "projects",
      "project_phases",
      "project_tasks",
      "investment_centers",
      "org_departments",
      "org_locations"
    ]
  },
  {
    module: "reporting.system",
    required: ["report_cache", "reporting_definition_audit"]
  },
  {
    module: "compliance.ifrs16",
    required: [
      "leases",
      "lease_contracts",
      "lease_assets",
      "lease_payments",
      "lease_schedule_lines",
      "lease_posting_ledger"
    ]
  },
  {
    module: "compliance.ifrs15",
    required: [
      "ifrs15_settings",
      "ifrs15_contracts",
      "ifrs15_performance_obligations",
      "ifrs15_recognition_schedule_lines",
      "ifrs15_posting_ledger"
    ]
  },
  {
    module: "compliance.ifrs9",
    required: [
      "ifrs9_settings",
      "ifrs9_ecl_models",
      "ifrs9_ecl_runs",
      "ifrs9_ecl_run_lines",
      "ifrs9_posting_ledger"
    ]
  },
  {
    module: "compliance.ias12",
    required: [
      "ias12_settings",
      "ias12_tax_authorities",
      "ias12_tax_rate_sets",
      "ias12_deferred_tax_runs",
      "ias12_deferred_tax_postings"
    ]
  },
  {
    module: "utilities.scheduler",
    required: ["scheduled_tasks", "scheduled_task_runs"]
  },
  {
    module: "utilities.errors",
    required: ["error_logs"]
  },
  {
    module: "utilities.security",
    required: ["data_retention_policies", "rate_limit_windows", "password_reset_tokens"]
  }
];

async function moduleTableCheck() {
  const results = [];
  for (const m of MODULE_REGISTRY) {
    const missing = [];
    for (const t of m.required) {
      const ok = await tableExists(t);
      if (!ok) missing.push(t);
    }
    results.push({
      module: m.module,
      ok: missing.length === 0,
      requiredCount: m.required.length,
      presentCount: m.required.length - missing.length,
      missingTables: missing
    });
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

  const lastByCode = new Map(recentRuns.map((r) => [r.task_code, r]));

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
  const statsByCode = new Map(stats.map((s) => [s.task_code, s]));

  const enriched = tasks.map((t) => {
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

function summarizeModules(modules) {
  const total = modules.length;
  const healthy = modules.filter((m) => m.ok).length;
  const unhealthyModules = modules.filter((m) => !m.ok).map((m) => m.module);
  return {
    total,
    healthy,
    unhealthy: total - healthy,
    unhealthyModules
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
    res.status(503).json({
      ok: false,
      service: "aptbooks-backend",
      db: { ok: false, error: e?.message || "db_error" },
      timestamp: nowIso()
    });
  }
});

router.get(
  "/health/modules",
  authRequired,
  requirePermission("settings.read"),
  async (_req, res) => {
    try {
      const modules = await moduleTableCheck();
      const summary = summarizeModules(modules);
      res.status(summary.unhealthy ? 503 : 200).json({
        ok: summary.unhealthy === 0,
        timestamp: nowIso(),
        summary,
        modules
      });
    } catch (e) {
      res.status(503).json({ ok: false, timestamp: nowIso(), error: e?.message || "module_health_error" });
    }
  }
);

router.get(
  "/health/modules/:moduleKey",
  authRequired,
  requirePermission("settings.read"),
  async (req, res) => {
    try {
      const key = String(req.params.moduleKey || "").replace(/~/g, "/");
      const modules = await moduleTableCheck();
      const exact = modules.find((m) => m.module === key);
      const aliases = modules.find((m) => m.module === key.replace(/\//g, "."));
      const match = exact || aliases;
      if (!match) {
        return res.status(404).json({ ok: false, error: "module_not_found", moduleKey: key, timestamp: nowIso() });
      }
      return res.status(match.ok ? 200 : 503).json({ ok: match.ok, timestamp: nowIso(), module: match });
    } catch (e) {
      return res.status(503).json({ ok: false, timestamp: nowIso(), error: e?.message || "module_health_error" });
    }
  }
);

// --- Comprehensive authenticated report ---
router.get(
  "/health/system",
  authRequired,
  requirePermission("settings.read"),
  async (_req, res) => {
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
      moduleSummary: null,
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
      checks.moduleSummary = summarizeModules(checks.modules);
      if (checks.moduleSummary.unhealthy > 0) checks.ok = false;
    } catch (e) {
      checks.ok = false;
      checks.modules = [{ module: "module_table_check", ok: false, error: e?.message || "error" }];
      checks.moduleSummary = { total: 0, healthy: 0, unhealthy: 1, unhealthyModules: ["module_table_check"] };
    }

    // scheduled_tasks / scheduled_task_runs are global platform control-plane
    // tables. Tenant settings users must not receive task names, run history,
    // failure details, or stack/error text from other organizations' jobs.
    checks.scheduler = { restricted: true };

    checks.elapsed_ms = Date.now() - t0;
    res.status(checks.ok ? 200 : 503).json(checks);
  }
);

module.exports = { healthRouter: router, schedulerHealthSummary, moduleTableCheck, MODULE_REGISTRY };
