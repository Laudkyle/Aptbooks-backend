const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const logger = require("./config/logger");

const { errorMiddleware } = require("./middleware/error.middleware");
const { notFoundMiddleware } = require("./middleware/notFound.middleware");
const { auditMiddleware } = require("./middleware/audit.middleware");
const { requestIdMiddleware } = require("./middleware/requestId.middleware");
const { requestSafetyMiddleware } = require("./shared/http/requestValidation");
const { rejectTenantSpoofing } = require("./middleware/tenantHeader.middleware");
const { globalRateLimit, authRateLimit } = require("./middleware/rateLimit.middleware");
const { env, validateRuntimeEnv } = require("./config/env");
const { tracingMiddleware } = require('./observability/trace');
const { httpMetricsMiddleware } = require('./observability/httpMetrics.middleware');
const { metricsRouter } = require('./observability/metrics.routes');
const { requestDrainMiddleware } = require('./ops/gracefulShutdown');
validateRuntimeEnv();

const authRoutes = require("./core/foundation/users/auth.routes");
const orgRoutes = require("./core/foundation/organizations/organizations.routes");

const coaRoutes = require("./core/accounting/chart-of-accounts/coa.routes");
const periodRoutes = require("./core/accounting/periods/periods.routes");
const journalRoutes = require("./core/accounting/journal/journal.routes");
const balanceRoutes = require("./core/accounting/ledger/balances.routes");
const fxRoutes = require("./core/accounting/fx/fx.routes");
const accountingStatementRoutes = require("./core/accounting/ledger/statements.routes");
const reconciliationRoutes = require("./core/accounting/ledger/reconciliation.routes");
const financialIntegrityRoutes = require("./core/accounting/integrity/financialIntegrity.routes");
const accountingPolicyRoutes = require("./core/accounting/policy/accountingPolicy.routes");
const accountingImportRoutes = require("./core/accounting/imports/imports.routes");
const accountingExportRoutes = require("./core/accounting/ledger/exports.routes");
const taxAdminRoutes = require("./core/accounting/tax/tax.routes");

const webhookRoutes = require("./modules/webhooks/webhooks.routes");
const businessModuleRoutes = require("./modules/business/business.routes");
const transactionsModuleRoutes = require("./modules/transactions/transactions.routes");
const arOpsRoutes = require("./modules/ar/ar.routes");
const integrationsRoutes = require("./modules/integrations/integrations.routes");
const commerceRoutes = require("./modules/commerce/commerce.routes");
const permissionsRoutes = require("./core/foundation/permissions/permissions.routes");
const rolesRoutes = require("./core/foundation/roles/roles.routes");
const usersRoutes = require("./core/foundation/users/users.routes");
const settingsRoutes = require("./core/foundation/system-settings/system-settings.routes");
const dimensionSecurityRoutes = require("./core/foundation/dimension-security/dimensionSecurity.routes");
const accrualRoutes = require("./core/accounting/accruals/accruals.routes");
const notificationsRoutes = require("./notifications/notifications.routes");
const searchRoutes = require("./search/search.routes");
const referenceRoutes = require("./core/foundation/reference/reference.routes");

// Tier 10: Documents & Workflow
const documentsWorkflowRoutes = require("./workflow/documents/documents.routes");

// Tier 8: Compliance (IFRS/IAS)
const complianceRoutes = require("./compliance/compliance.routes");
const { healthRouter } = require("./health/health.routes");

const app = express();

// Correct client IP/Proto when behind a reverse proxy (e.g., Nginx, ALB).
app.set("trust proxy", env.TRUST_PROXY);


const swaggerUi = require("swagger-ui-express");
const { swaggerDocument } = require("./docs/swagger");


const corsOptions = {
  origin: function (origin, cb) {
    // Allow non-browser tools (no Origin header)
    if (!origin) return cb(null, true);

    // If allowlist is empty, block in production; allow in non-production.
    if (!env.CORS_ALLOWED_ORIGINS || env.CORS_ALLOWED_ORIGINS.length === 0) {
      if (env.NODE_ENV === "production") return cb(new Error("CORS origin not allowed"));
      return cb(null, true);
    }

    if (env.CORS_ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    logger.warn({ origin }, "CORS origin not allowed");
    return cb(new Error("CORS origin not allowed"));
  },
  credentials: env.CORS_ALLOW_CREDENTIALS,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Authorization",
    "Content-Type",
    "Idempotency-Key",
    "x-request-id",
    "x-filename",
    "x-refresh-token",
    "x-api-key",
    "traceparent"
  ],
  exposedHeaders: ["x-request-id", "x-trace-id", "traceparent", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(helmet({
  // API-first backend; Swagger UI uses inline scripts/styles.
  contentSecurityPolicy: false
}));

app.use(express.json({
  limit: "10mb",
  verify: (req, res, buf) => {
    // Needed for webhook signature verification (e.g., Paystack)
    req.rawBody = buf;
  }
}));

app.use(requestIdMiddleware);
app.use(tracingMiddleware({ sampleRatio: env.TRACE_SAMPLE_RATIO }));
app.use(httpMetricsMiddleware);
// Metrics scraping must remain available even when PostgreSQL-backed API rate
// limiting or downstream application routes are degraded. Production metrics
// still require a strong bearer token and should be network-restricted.
app.use("/", metricsRouter);
app.use(requestSafetyMiddleware);
app.use(rejectTenantSpoofing);
app.use(globalRateLimit);


app.use(auditMiddleware);

// Public docs and utility APIs are mounted after core security, parsing,
// request-id, rate-limit, and audit middleware so they share the same
// observability and baseline protection as application routes.
if (env.EXPOSE_SWAGGER) {
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}
if (env.EXPOSE_INTERNAL_UTILITIES) {
  app.use("/utilities/scheduled-tasks", require("./utilities/scheduled-tasks/scheduledTasks.routes"));
  app.use("/utilities/tests", require("./utilities/tests/tests.routes"));
}
app.use("/utilities/errors", require("./utilities/errors/errors.routes"));
app.use("/utilities/client-logs", require("./utilities/client-logs/clientLogs.routes"));
app.use("/utilities/i18n", require("./utilities/i18n/i18n.routes"));
app.use("/utilities/a11y", require("./utilities/a11y/a11y.routes"));
app.use("/utilities/release", require("./utilities/release/release.routes"));

// Liveness / readiness / comprehensive health report.
app.use("/", healthRouter);

// Once shutdown draining starts, health/metrics remain available while normal
// application traffic receives a retryable 503 and connections are closed.
app.use(requestDrainMiddleware);

app.use("/auth", authRateLimit, authRoutes);
app.use("/core/users", usersRoutes);
app.use("/core/roles", rolesRoutes);
app.use("/core/organizations", orgRoutes);
app.use("/core/permissions", permissionsRoutes);
app.use("/core/settings", settingsRoutes);
app.use("/core/dimension-security", dimensionSecurityRoutes);
app.use("/core/api-keys", require("./core/foundation/api-keys/apiKeys.routes"));
app.use("/core/accounting/accruals", accrualRoutes);
app.use("/core/reference", referenceRoutes);


app.use("/core/accounting/accounts", coaRoutes);
app.use("/core/accounting/periods", periodRoutes);
app.use("/core/accounting/journals", journalRoutes);
app.use("/core/accounting/balances", balanceRoutes);
app.use("/core/accounting/fx", fxRoutes);
app.use("/core/accounting/tax", taxAdminRoutes);
app.use("/core/accounting/statements", accountingStatementRoutes);
app.use("/core/accounting/reconciliation", reconciliationRoutes);
app.use("/core/accounting/integrity", financialIntegrityRoutes);
app.use("/core/accounting/policy", accountingPolicyRoutes);
app.use("/core/accounting/imports", accountingImportRoutes);
app.use("/core/accounting/exports", accountingExportRoutes);


app.use("/modules/webhooks", webhookRoutes);

app.use("/modules/business", businessModuleRoutes);
app.use("/modules/transactions", transactionsModuleRoutes);
app.use("/modules/ar", arOpsRoutes);
app.use("/modules/assets", require("./modules/assets/assets.routes"));
app.use("/modules/inventory", require("./modules/inventory/inventory.routes"));
app.use("/modules/banking", require("./modules/banking/banking.routes"));
app.use("/modules/automation", require("./modules/automation/automation.routes"));
app.use("/modules/printing", require("./modules/printing/printing.routes"));

// Stage 6: Integrations (payments, e-invoicing, tax forms)
app.use("/modules/integrations", integrationsRoutes);
app.use("/modules/commerce", commerceRoutes);

// Stage 1: HR (Foundation)
app.use("/modules/hr", require("./modules/hr/hr.routes"));

// Tier 8: Compliance
app.use("/compliance", complianceRoutes);

// Tier 6: Reporting & Analytics
app.use("/reporting", require("./reporting/reports.routes"));

// Tier 10: Documents & Workflow
app.use("/workflow/documents", documentsWorkflowRoutes);
app.use("/workflow/approvals", require("./workflow/approvals/approvals.routes"));

// Phase 2: Notifications + Global Search
app.use("/core/notifications", notificationsRoutes);
app.use("/search", searchRoutes);


app.use(notFoundMiddleware);
app.use(errorMiddleware);

module.exports = app;
