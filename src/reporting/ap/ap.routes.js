const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./ap.service");

const router = express.Router();

router.use(requirePermission("reporting.ap.read"));

router.get("/aged-payables", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { asOfDate, bucketSetId } = req.query;
    const data = await svc.agedPayables({ orgId, asOfDate, bucketSetId: bucketSetId ? Number(bucketSetId) : undefined });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Drill-down / open items
router.get("/open-items", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { vendorId } = req.query;
    const { rows } = await require("../../db/pool").pool.query(
      `SELECT * FROM reporting_ap_open_items WHERE organization_id=$1 AND outstanding > 0 AND ($2::bigint IS NULL OR vendor_id=$2) ORDER BY due_date NULLS LAST, bill_id`,
      [orgId, vendorId ? Number(vendorId) : null]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/open-items", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { vendorId } = req.query;
    const { rows } = await require("../../db/pool").pool.query(
      `SELECT * FROM reporting_ap_open_items WHERE organization_id=$1 AND outstanding > 0 AND ($2::bigint IS NULL OR vendor_id=$2) ORDER BY due_date NULLS LAST, bill_id`,
      [orgId, vendorId ? Number(vendorId) : null]
    );
    res.json({ data: rows });
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
