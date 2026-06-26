const express = require("express");
const { authRequired } = require("../middleware/auth.middleware");
const { enforceDimensionAccess } = require("../middleware/dimensionAccess.middleware");

const router = express.Router();

// All reporting endpoints require authentication.
router.use(authRequired);

// Stage 4: Dimension-level access control applies when a request includes a
// dimensionJson filter (query or body). This is intentionally non-breaking:
// if no rules exist, the request proceeds.
router.use(enforceDimensionAccess);

router.use(
  "/financial-statements",
  require("./financial-statements/financialStatements.routes")
);
router.use("/ar", require("./ar/ar.routes"));
router.use("/ap", require("./ap/ap.routes"));
router.use("/banking", require("./banking/banking.routes"));
router.use("/inventory", require("./inventory/inventory.routes"));
router.use("/kpis", require("./kpis/kpis.routes"));
router.use("/budgets", require("./budgets/budgets.routes"));
router.use("/forecasts", require("./forecasts/forecasts.routes"));
router.use("/centers", require("./dimensions/centers.routes"));
router.use("/projects", require("./dimensions/projects.routes"));
router.use("/allocations", require("./allocations/allocations.routes"));
router.use("/tax", require("./tax/tax.routes"));
router.use("/audit", require("./audit/audit.routes"));
router.use("/exports", require("./exports/exports.routes"));
router.use("/analytics", require("./analytics/analytics.routes"));

// Stage 3: saved report builder, dashboards, management reports
router.use("/reports", require("./report-builder/reportBuilder.routes"));
router.use("/saved-reports", require("./report-builder/reportBuilder.routes"));
router.use("/dashboards", require("./dashboards/dashboards.routes"));
router.use("/management", require("./management/managementReports.routes"));

// Reporting configuration (aging buckets, etc.)
router.use("/config", require("./config/agingBuckets.routes"));

// Operational visibility (scheduler health KPIs, etc.)
router.use("/system", require("./system/system.routes"));

module.exports = router;
