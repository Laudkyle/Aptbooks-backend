const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

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
const businessModuleRoutes = require("./modules/business/business.routes");
const transactionsModuleRoutes = require("./modules/transactions/transactions.routes");
const permissionsRoutes = require("./core/foundation/permissions/permissions.routes");
const rolesRoutes = require("./core/foundation/roles/roles.routes");
const usersRoutes = require("./core/foundation/users/users.routes");
const settingsRoutes = require("./core/foundation/system-settings/system-settings.routes");
const accrualRoutes = require("./core/accounting/accruals/accruals.routes");

// Tier 10: Documents & Workflow
const documentsWorkflowRoutes = require("./workflow/documents/documents.routes");

// Tier 8: Compliance (IFRS/IAS)
const complianceRoutes = require("./compliance/compliance.routes");
const { healthRouter } = require("./health/health.routes");

const app = express();

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
    return cb(new Error("CORS origin not allowed"));
  },
  credentials: env.CORS_ALLOW_CREDENTIALS,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "x-request-id", "x-filename"],
  exposedHeaders: ["x-request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "1mb" }));

app.use(requestIdMiddleware);
app.use(globalRateLimit);


app.use(auditMiddleware);

app.use("/auth", authRateLimit, authRoutes);
app.use("/core/users", usersRoutes);
app.use("/core/roles", rolesRoutes);
app.use("/core/organizations", orgRoutes);
app.use("/core/permissions", permissionsRoutes);
app.use("/core/settings", settingsRoutes);
app.use("/core/accounting/accruals", accrualRoutes);

app.use("/core/accounting/accounts", coaRoutes);
app.use("/core/accounting/periods", periodRoutes);
app.use("/core/accounting/journals", journalRoutes);
app.use("/core/accounting/balances", balanceRoutes);

app.use("/modules/business", businessModuleRoutes);
app.use("/modules/transactions", transactionsModuleRoutes);
app.use("/modules/assets", require("./modules/assets/assets.routes"));
app.use("/modules/inventory", require("./modules/inventory/inventory.routes"));
app.use("/modules/banking", require("./modules/banking/banking.routes"));

// Tier 8: Compliance
app.use("/compliance", complianceRoutes);

// Tier 6: Reporting & Analytics
app.use("/reporting", require("./reporting/reports.routes"));

// Tier 10: Documents & Workflow
app.use("/workflow/documents", documentsWorkflowRoutes);


app.use(errorMiddleware);

module.exports = app;
