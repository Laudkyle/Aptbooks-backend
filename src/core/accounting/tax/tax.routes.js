const express = require("express");

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const setupRoutes = require("./tax-setup.routes");
const complianceRoutes = require("./tax-compliance.routes");
const returnsRoutes = require("./tax-returns.routes");
const withholdingRoutes = require("./tax-withholding.routes");

const router = express.Router();
router.use(authRequired);
router.use(requirePermission("tax.read"));

// Phase 3: compose bounded tax route modules in the original registration order.
router.use(setupRoutes);
router.use(complianceRoutes);
router.use(returnsRoutes);
router.use(withholdingRoutes);

module.exports = router;
