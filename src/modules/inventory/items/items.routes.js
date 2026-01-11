const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./items.service");

router.use(authRequired);

router.get("/", requirePermission("inventory.items.read"), async (req, res, next) => {
  try { res.json(await svc.listItems(req.user.organization_id)); }
  catch (e) { next(e); }
});

router.post("/", idempotency({ required: true }), requirePermission("inventory.items.manage"), async (req, res, next) => {
  try {
    const created = await svc.createItem(req.user.organization_id, req.body);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

module.exports = router;
