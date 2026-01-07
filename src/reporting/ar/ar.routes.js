const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./ar.service");

const router = express.Router();

router.use(requirePermission("reporting.ar.read"));

router.get("/aged-receivables", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { asOfDate } = req.query;
    const data = await svc.agedReceivables({ orgId, asOfDate });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/customer-statement", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { customerId, from, to } = req.query;
    const data = await svc.customerStatement({ orgId, customerId, fromDate: from, toDate: to });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
