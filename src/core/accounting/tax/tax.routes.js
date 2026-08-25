const express = require("express");

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const workspaceRoutes = require("./tax-workspace.routes");
const setupRoutes = require("./tax-setup.routes");
const complianceRoutes = require("./tax-compliance.routes");
const returnsRoutes = require("./tax-returns.routes");
const withholdingRoutes = require("./tax-withholding.routes");

const router = express.Router();
router.use(authRequired);

// The workspace summary is readable by either the general tax reader or the
// dedicated Ghana-readiness role. Remaining tax APIs retain tax.read.
router.use(workspaceRoutes);
router.use(requirePermission("tax.read"));
router.use(setupRoutes);
router.use(complianceRoutes);
router.use(returnsRoutes);
router.use(withholdingRoutes);

module.exports = router;
