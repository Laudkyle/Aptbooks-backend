const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require("express").Router();
router.use(createModuleBodyContract(['code', 'name']));
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./itemUnits.service");

router.use(authRequired);

router.get("/", requirePermission("inventory.units.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listUnits(orgId));
  } catch (e) { next(e); }
});

router.post("/", idempotency({ required: true }), requirePermission("inventory.units.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const created = await svc.createUnit(orgId, req.body);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

module.exports = router;
