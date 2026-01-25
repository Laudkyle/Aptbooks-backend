const router = require("express").Router(); 
const { authRequired } = require("../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const { AppError } = require("../../../shared/errors/AppError"); 
const balanceAPI = require("../../../interfaces/balanceInquiry.interface"); 

router.use(authRequired); 

router.get("/trial-balance", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const { periodId } = req.query; 
    if (!periodId) throw new AppError(400, "periodId required"); 
    res.json(await balanceAPI.trialBalance({ orgId, periodId })); 
  } catch (e) { next(e);  }
}); 

router.get("/gl", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const { periodId } = req.query; 
    if (!periodId) throw new AppError(400, "periodId required"); 
    res.json(await balanceAPI.glBalances({ orgId, periodId })); 
  } catch (e) { next(e);  }
}); 

router.get("/account-activity", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const { accountId, from, to } = req.query; 
    if (!accountId || !from || !to) throw new AppError(400, "accountId, from, to are required"); 
    res.json(await balanceAPI.accountActivity({ orgId, accountId, fromDate: from, toDate: to })); 
  } catch (e) { next(e);  }
}); 

module.exports = router; 
