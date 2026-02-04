const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const logger = require("./config/logger");

const { errorMiddleware } = require("./middleware/error.middleware");
const { auditMiddleware } = require("./middleware/audit.middleware");
const { requestIdMiddleware } = require("./middleware/requestId.middleware");
const { globalRateLimit, authRateLimit } = require("./middleware/rateLimit.middleware");
const { env } = require("./config/env");

const authRoutes = require("./core/foundation/users/auth.routes");
const orgRoutes = require("./core/foundation/organizations/organizations.routes");

const coaRoutes = require("./core/accounting/chart-of-accounts/coa.routes");
const periodRoutes = require("./core/accounting/periods/periods.routes");
const journalRoutes = require("./core/accounting/journal/journal.routes");
const balanceRoutes = require("./core/accounting/ledger/balances.routes");
const fxRoutes = require("./core/accounting/fx/fx.routes");
const accountingStatementRoutes = require("./core/accounting/ledger/statements.routes");
const reconciliationRoutes = require("./core/accounting/ledger/reconciliation.routes");
const accountingImportRoutes = require("./core/accounting/imports/imports.routes");
const accountingExportRoutes = require("./core/accounting/ledger/exports.routes");
const taxAdminRoutes = require("./core/accounting/tax/tax.routes");

const webhookRoutes = require("./modules/webhooks/webhooks.routes");
const businessModuleRoutes = require("./modules/business/business.routes");
const transactionsModuleRoutes = require("./modules/transactions/transactions.routes");
const arOpsRoutes = require("./modules/ar/ar.routes");
const integrationsRoutes = require("./modules/integrations/integrations.routes");
const permissionsRoutes = require("./core/foundation/permissions/permissions.routes");
const rolesRoutes = require("./core/foundation/roles/roles.routes");
const usersRoutes = require("./core/foundation/users/users.routes");
const settingsRoutes = require("./core/foundation/system-settings/system-settings.routes");
const dimensionSecurityRoutes = require("./core/foundation/dimension-security/dimensionSecurity.routes");
const accrualRoutes = require("./core/accounting/accruals/accruals.routes");
const notificationsRoutes = require("./notifications/notifications.routes");
const searchRoutes = require("./search/search.routes");

// Tier 10: Documents & Workflow
const documentsWorkflowRoutes = require("./workflow/documents/documents.routes");

// Tier 8: Compliance (IFRS/IAS)
const complianceRoutes = require("./compliance/compliance.routes");
const { healthRouter } = require("./health/health.routes");

const app = express();

// Correct client IP/Proto when behind a reverse proxy (e.g., Nginx, ALB).
app.set("trust proxy", env.TRUST_PROXY);

// Liveness / readiness / comprehensive health report
app.use("/", healthRouter);

// Trust reverse proxy headers (set TRUST_PROXY=true when behind a proxy / load balancer)
if (env.TRUST_PROXY) {
  app.set("trust proxy", 1);
}
const swaggerUi = require("swagger-ui-express");
const { swaggerDocument } = require("./docs/swagger");

// Public docs (recommended)
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use("/utilities/scheduled-tasks", require("./utilities/scheduled-tasks/scheduledTasks.routes"));
app.use("/utilities/errors", require("./utilities/errors/errors.routes"));
app.use("/utilities/client-logs", require("./utilities/client-logs/clientLogs.routes"));
app.use("/utilities/i18n", require("./utilities/i18n/i18n.routes"));
app.use("/utilities/a11y", require("./utilities/a11y/a11y.routes"));
app.use("/utilities/release", require("./utilities/release/release.routes"));
app.use("/utilities/tests", require("./utilities/tests/tests.routes"));

app.use(helmet({
  // API-first backend; Swagger UI uses inline scripts/styles.
  contentSecurityPolicy: false
}));

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
    "x-api-key"
  ],
  exposedHeaders: ["x-request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({
  limit: "1mb",
  verify: (req, res, buf) => {
    // Needed for webhook signature verification (e.g., Paystack)
    req.rawBody = buf;
  }
}));

app.use(requestIdMiddleware);
app.use(globalRateLimit);


app.use(auditMiddleware);

app.use("/auth", authRateLimit, authRoutes);
app.use("/core/users", usersRoutes);
app.use("/core/roles", rolesRoutes);
app.use("/core/organizations", orgRoutes);
app.use("/core/permissions", permissionsRoutes);
app.use("/core/settings", settingsRoutes);
app.use("/core/dimension-security", dimensionSecurityRoutes);
app.use("/core/api-keys", require("./core/foundation/api-keys/apiKeys.routes"));
app.use("/core/accounting/accruals", accrualRoutes);

app.use("/core/accounting/accounts", coaRoutes);
app.use("/core/accounting/periods", periodRoutes);
app.use("/core/accounting/journals", journalRoutes);
app.use("/core/accounting/balances", balanceRoutes);
app.use("/core/accounting/fx", fxRoutes);
app.use("/core/accounting/tax", taxAdminRoutes);
app.use("/core/accounting/statements", accountingStatementRoutes);
app.use("/core/accounting/reconciliation", reconciliationRoutes);
app.use("/core/accounting/imports", accountingImportRoutes);
app.use("/core/accounting/exports", accountingExportRoutes);


app.use("/modules/webhooks", webhookRoutes);

app.use("/modules/business", businessModuleRoutes);
app.use("/modules/transactions", transactionsModuleRoutes);
app.use("/modules/ar", arOpsRoutes);
app.use("/modules/assets", require("./modules/assets/assets.routes"));
app.use("/modules/inventory", require("./modules/inventory/inventory.routes"));
app.use("/modules/banking", require("./modules/banking/banking.routes"));

// Stage 6: Integrations (payments, e-invoicing, tax forms)
app.use("/modules/integrations", integrationsRoutes);

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


app.use(errorMiddleware);

module.exports = app;
