const router = require("express").Router(); 
const { authRequired } = require("../../middleware/auth.middleware"); 
const { requirePermission } = require("../../middleware/permission.middleware"); 
const svc = require("./approvals.service"); 

router.use(authRequired); 

router.get("/inbox", requirePermission("approvals.inbox.read"), async (req, res, next) => {
  try {
    res.json(await svc.inbox(req.user.organization_id, req.query)); 
  } catch (e) { next(e);  }
}); 

module.exports = router; 
