const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./reconciliations.service");

router.use(authRequired);

router.get("/", requirePermission("banking.reconciliations.read"), async (req, res, next) => {
  try {
    res.json(await svc.listReconciliations(req.user.organization_id, req.query));
  } catch (e) { next(e);}
});

router.get("/:id", requirePermission("banking.reconciliations.read"), async (req, res, next) => {
  try {
    res.json(await svc.getReconciliation(req.user.organization_id, req.params.id));
  } catch (e) { next(e);}
});

router.post("/", idempotency({ required: true }), requirePermission("banking.reconciliation.run"), async (req, res, next) => {
  try {
    const result = await svc.reconcile(req.user.organization_id, req.user.id, req.body);
    res.status(201).json(result);
  } catch (e) { next(e);}
});

router.post("/:id/close", idempotency({ required: true }), requirePermission("banking.reconciliation.run"), async (req, res, next) => {
  try {
    res.json(await svc.closeReconciliation(req.user.organization_id, req.user.id, req.params.id, req.body || {}));
  } catch (e) { next(e);}
});

router.post("/:id/unlock", idempotency({ required: true }), requirePermission("banking.reconciliation.run"), async (req, res, next) => {
  try {
    res.json(await svc.unlockReconciliation(req.user.organization_id, req.user.id, req.params.id));
  } catch (e) { next(e);}
});

router.get("/:id/diff", requirePermission("banking.reconciliations.read"), async (req, res, next) => {
  try {
    res.json(await svc.computeDiff(req.user.organization_id, req.params.id));
  } catch (e) { next(e);}
});

module.exports = router;
