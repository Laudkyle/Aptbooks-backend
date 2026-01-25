const express = require("express"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const exportsApi = require("../../../interfaces/dataExport.interface"); 
const { authRequired } = require("../../../middleware/auth.middleware"); 

const router = express.Router(); 
router.use(authRequired)


router.get("/trial-balance", requirePermission("accounting.exports.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user; 
    const { periodId, format = "json" } = req.query; 
    const out = await exportsApi.exportTrialBalance({ orgId, periodId, format }); 
    if (out.contentType) res.setHeader("Content-Type", out.contentType); 
    res.send(out.body); 
  } catch (err) {
    next(err); 
  }
}); 

router.get("/general-ledger", requirePermission("accounting.exports.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user; 
    const { periodId, format = "json" } = req.query; 
    const out = await exportsApi.exportGeneralLedger({ orgId, periodId, format }); 
    if (out.contentType) res.setHeader("Content-Type", out.contentType); 
    res.send(out.body); 
  } catch (err) {
    next(err); 
  }
}); 

router.get("/account-activity", requirePermission("accounting.exports.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user; 
    const { accountId, fromDate, toDate, format = "json" } = req.query; 
    const out = await exportsApi.exportAccountActivity({ orgId, accountId, fromDate, toDate, format }); 
    if (out.contentType) res.setHeader("Content-Type", out.contentType); 
    res.send(out.body); 
  } catch (err) {
    next(err); 
  }
}); 

module.exports = router; 
