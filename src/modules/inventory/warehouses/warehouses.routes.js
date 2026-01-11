const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./warehouses.service");

router.use(authRequired);

router.get("/", requirePermission("inventory.warehouses.read"), async (req, res, next) => {
  try { res.json(await svc.listWarehouses(req.user.organization_id)); }
  catch (e) { next(e); }
});

router.post("/", idempotency({ required: true }), requirePermission("inventory.warehouses.manage"), async (req, res, next) => {
  try {
    const created = await svc.createWarehouse(req.user.organization_id, req.body);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

module.exports = router;
