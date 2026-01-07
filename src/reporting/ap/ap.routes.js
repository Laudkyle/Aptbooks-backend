const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./ap.service");

const router = express.Router();

router.use(requirePermission("reporting.ap.read"));

router.get("/aged-payables", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { asOfDate } = req.query;
    const data = await svc.agedPayables({ orgId, asOfDate });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/vendor-statement", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { vendorId, from, to } = req.query;
    const data = await svc.vendorStatement({ orgId, vendorId, fromDate: from, toDate: to });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
