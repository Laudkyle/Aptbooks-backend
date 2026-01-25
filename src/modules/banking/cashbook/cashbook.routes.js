const express = require("express"); 
const { authRequired } = require("../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const svc = require("./cashbook.service"); 

const router = express.Router(); 

router.use(authRequired); 

// GET /modules/banking/cashbook?bankAccountId=&dateFrom=&dateTo=&limit=&offset=&includeRunningBalance=true
router.get("/", requirePermission("banking.cashbook.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user; 
    res.json(await svc.listCashbook(orgId, req.query)); 
  } catch (e) { next(e);  }
}); 


module.exports = router; 
