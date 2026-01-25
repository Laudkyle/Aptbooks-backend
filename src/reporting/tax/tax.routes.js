const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./tax.service");

const router = express.Router();

router.use(requirePermission("reporting.tax.read"));

// VAT/GST summary for a date range.
router.get("/vat-summary", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to } = req.query;
    const data = await svc.vatSummary({ orgId, fromDate: from, toDate: to });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// VAT/GST return (box-based)
router.get("/vat-return", async (req, res, next) => {
  try {
    const { organization_id: orgId, id: userId } = req.user;
    const { from, to, templateCode } = req.query;
    const data = await svc.vatReturn({ orgId, userId, fromDate: from, toDate: to, templateCode });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/returns", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { taxType, from, to } = req.query;
    const data = await svc.listReturns({ orgId, taxType, fromDate: from, toDate: to });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
