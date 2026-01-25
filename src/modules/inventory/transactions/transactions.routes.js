const router = require("express").Router(); 
const { authRequired } = require("../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const { idempotency } = require("../../../middleware/idempotency.middleware"); 
const svc = require("./transactions.service"); 

router.use(authRequired); 

router.get("/", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.listTransactions({ orgId, query: req.query })); 
  } catch (e) { next(e);  }
}); 

router.get("/cost-method", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    res.json(await svc.ensureCostMethod(req.user.organization_id)); 
  } catch (e) { next(e);  }
}); 

router.get("/:id", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.getTransaction({ orgId, transactionId: req.params.id })); 
  } catch (e) { next(e);  }
}); 

// Option A workflow: create draft -> approve -> post
router.post("/", idempotency({ required: true }), requirePermission("inventory.transactions.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const result = await svc.createDraftTransaction({ orgId, actorUserId, payload: req.body }); 
    res.status(201).json(result); 
  } catch (e) { next(e);  }
}); 

router.post("/:id/approve", idempotency({ required: true }), requirePermission("inventory.transactions.approve"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    res.json(await svc.approveTransaction({ orgId, actorUserId, transactionId: req.params.id })); 
  } catch (e) { next(e);  }
}); 

router.post("/:id/post", idempotency({ required: true }), requirePermission("inventory.transactions.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    res.status(201).json(await svc.postApprovedTransaction({ orgId, actorUserId, transactionId: req.params.id })); 
  } catch (e) { next(e);  }
}); 

router.post("/:id/void", idempotency({ required: true }), requirePermission("inventory.transactions.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    res.json(await svc.voidTransaction({ orgId, actorUserId, transactionId: req.params.id, reason: req.body?.reason })); 
  } catch (e) { next(e);  }
}); 

router.post("/:id/reverse", idempotency({ required: true }), requirePermission("inventory.transactions.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    res.json(await svc.reversePostedTransaction({ orgId, actorUserId, transactionId: req.params.id })); 
  } catch (e) { next(e);  }
}); 

module.exports = router; 
