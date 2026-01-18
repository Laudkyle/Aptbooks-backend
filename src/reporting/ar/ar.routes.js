const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./ar.service");

const router = express.Router();

router.use(requirePermission("reporting.ar.read"));

router.get("/aged-receivables", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { asOfDate, bucketSetId } = req.query;
    const data = await svc.agedReceivables({ orgId, asOfDate, bucketSetId: bucketSetId ? Number(bucketSetId) : undefined });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Drill-down / open items
router.get("/open-items", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { customerId } = req.query;
    const { rows } = await require("../../db/pool").pool.query(
      `SELECT * FROM reporting_ar_open_items WHERE organization_id=$1 AND outstanding > 0 AND ($2::bigint IS NULL OR customer_id=$2) ORDER BY due_date NULLS LAST, invoice_id`,
      [orgId, customerId ? Number(customerId) : null]
    );
    res.json({ data: rows });
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
