const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./inventory.service");

const router = express.Router();

router.use(requirePermission("reporting.inventory.read"));

router.get("/valuation-current", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { warehouseId } = req.query;
    const data = await svc.valuationCurrent({ orgId, warehouseId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
