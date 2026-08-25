const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require('../../../shared/validators/validate');
const { createUnitSchema } = require('../../../shared/validators/inventory.validators');
const svc = require("./itemUnits.service");

router.use(authRequired);
router.get("/", requirePermission("inventory.units.read"), async (req, res, next) => {
  try { res.json(await svc.listUnits(req.user.organization_id, req.query)); } catch (e) { next(e); }
});
router.post("/", idempotency({ required: true }), requirePermission("inventory.units.manage"), async (req, res, next) => {
  try { res.status(201).json(await svc.createUnit(req.user.organization_id, validate(createUnitSchema, req.body))); } catch (e) { next(e); }
});
module.exports = router;
