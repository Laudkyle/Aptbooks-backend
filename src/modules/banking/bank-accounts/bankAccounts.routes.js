const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require("express").Router();
router.use(createModuleBodyContract(['code', 'currencyCode', 'glAccountId', 'isActive', 'name']));
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./bankAccounts.service");

router.use(authRequired);

router.get("/", requirePermission("banking.accounts.read"), async (req, res, next) => {
  try { res.json(await svc.list(req.user.organization_id)); }
  catch (e) { next(e); }
});

router.post("/", idempotency({ required: true }), requirePermission("banking.accounts.manage"), async (req, res, next) => {
  try { res.status(201).json(await svc.create(req.user.organization_id, req.body)); }
  catch (e) { next(e); }
});

module.exports = router;
