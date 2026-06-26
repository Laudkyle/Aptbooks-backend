const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./ap.service");

const router = express.Router();
const { resolveOrgId } = require("../_util");

router.use(requirePermission("reporting.ap.read"));

router.get("/aged-payables", async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { asOfDate, bucketSetId } = req.query;
    
    // Handle bucketSetId properly - don't convert to number, just pass undefined if it's "undefined" or empty
    const validBucketSetId = bucketSetId && bucketSetId !== 'undefined' && bucketSetId.trim() !== '' 
      ? bucketSetId 
      : undefined;
    
    const data = await svc.agedPayables({ 
      orgId, 
      asOfDate, 
      bucketSetId: validBucketSetId
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});


// Drill-down / open items - Fixed UUID handling
router.get("/open-items", async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { vendorId } = req.query;
    
    const { rows } = await require("../../db/pool").pool.query(
      `SELECT * FROM reporting_ap_open_items 
       WHERE organization_id=$1 
         AND outstanding > 0 
         AND ($2::uuid IS NULL OR vendor_id=$2::uuid) 
       ORDER BY due_date NULLS LAST, bill_id`,
      [orgId, vendorId || null]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/vendor-statement", async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { vendorId, from, to } = req.query;
    const data = await svc.vendorStatement({ 
      orgId, 
      vendorId, 
      fromDate: from, 
      toDate: to 
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;