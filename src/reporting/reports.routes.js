const express = require("express");
const { authRequired } = require("../middleware/auth.middleware");

const router = express.Router();

// All reporting endpoints require authentication.
router.use(authRequired);

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
router.use("/exports", require("./exports/exports.routes"));

module.exports = router;
