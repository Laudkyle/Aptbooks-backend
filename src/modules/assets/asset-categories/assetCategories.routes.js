const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { createAssetCategorySchema, updateAssetCategorySchema } = require("../../../shared/validators/assets.validators");
const svc = require("./assetCategories.service");

router.use(authRequired);

router.post("/", idempotency({ required: true }), requirePermission("assets.categories.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createAssetCategorySchema, req.body);
    res.status(201).json(await svc.createCategory({ orgId, actorUserId, payload, audit: req.audit }));
  } catch (e) { next(e); }
});

router.get("/", requirePermission("assets.categories.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listCategories({ orgId }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("assets.categories.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getCategory({ orgId, id: req.params.id }));
  } catch (e) { next(e); }
});

router.put("/:id", requirePermission("assets.categories.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(updateAssetCategorySchema, req.body);
    res.json(await svc.updateCategory({ orgId, actorUserId, id: req.params.id, payload, audit: req.audit }));
  } catch (e) { next(e); }
});

router.delete("/:id", requirePermission("assets.categories.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.archiveCategory({ orgId, actorUserId, id: req.params.id, audit: req.audit }));
  } catch (e) { next(e); }
});

module.exports = router;
