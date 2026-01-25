const router = require("express").Router(); 
const { authRequired } = require("../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const svc = require("./reports.service"); 

router.use(authRequired); 

router.get("/valuation", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const { warehouseId } = req.query; 
    res.json(await svc.inventoryValuation(orgId, { warehouseId })); 
  } catch (e) { next(e);  }
}); 

router.get("/movements", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const { from, to, warehouseId, itemId } = req.query; 
    res.json(await svc.inventoryMovements(orgId, { from, to, warehouseId, itemId })); 
  } catch (e) { next(e);  }
}); 

module.exports = router; 
