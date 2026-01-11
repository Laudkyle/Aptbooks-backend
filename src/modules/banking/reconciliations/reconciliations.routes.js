const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./reconciliations.service");

router.use(authRequired);

router.post("/", idempotency({ required: true }), requirePermission("banking.reconciliation.run"), async (req, res, next) => {
  try {
    const result = await svc.reconcile(req.user.organization_id, req.user.id, req.body);
    res.status(201).json(result);
  } catch (e) { next(e); }
});

module.exports = router;
