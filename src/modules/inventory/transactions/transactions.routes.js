const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./transactions.service");

router.use(authRequired);

router.post("/", idempotency({ required: true }), requirePermission("inventory.transactions.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const result = await svc.postInventoryTransaction({ orgId, actorUserId, payload: req.body });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

router.get("/cost-method", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.ensureCostMethod(orgId));
  } catch (e) { next(e); }
});

module.exports = router;
