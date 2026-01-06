const express = require("express");

/**
 * Tier 8: Compliance (IFRS/IAS)
 *
 * This is an aggregation router that mounts compliance submodules.
 *
 * Convention:
 *  - Each submodule is responsible for its own auth + permission gates.
 */
const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, module: "compliance" });
});

// IFRS 16: Leases
router.use("/ifrs16", require("./ifrs16/ifrs16.routes"));

// IFRS 15: Revenue from Contracts with Customers
router.use("/ifrs15", require("./ifrs15/ifrs15.routes"));

// IAS 12: Income Taxes
router.use("/ias12", require("./ias12/ias12.routes"));

// IFRS 9: Financial Instruments (Stage 1: Simplified ECL for trade receivables)
router.use("/ifrs9", require("./ifrs9/ifrs9.routes"));

module.exports = router;
