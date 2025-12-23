const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const { errorMiddleware } = require("./middleware/error.middleware");
const { auditMiddleware } = require("./middleware/audit.middleware");

const authRoutes = require("./core/foundation/users/auth.routes");
const orgRoutes = require("./core/foundation/organizations/organizations.routes");

const coaRoutes = require("./core/accounting/chart-of-accounts/coa.routes");
const periodRoutes = require("./core/accounting/periods/periods.routes");
const journalRoutes = require("./core/accounting/journal/journal.routes");
const balanceRoutes = require("./core/accounting/ledger/balances.routes");
const permissionsRoutes = require("./core/foundation/permissions/permissions.routes");
const rolesRoutes = require("./core/foundation/roles/roles.routes");
const usersRoutes = require("./core/foundation/users/users.routes");
const settingsRoutes = require("./core/foundation/system-settings/system-settings.routes");


const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use(auditMiddleware);

app.use("/auth", authRoutes);
app.use("/core/users", usersRoutes);
app.use("/core/roles", rolesRoutes);
app.use("/core/organizations", orgRoutes);
app.use("/core/permissions", permissionsRoutes);
app.use("/core/settings", settingsRoutes);

app.use("/core/accounting/accounts", coaRoutes);
app.use("/core/accounting/periods", periodRoutes);
app.use("/core/accounting/journals", journalRoutes);
app.use("/core/accounting/balances", balanceRoutes);

app.use(errorMiddleware);

module.exports = app;
