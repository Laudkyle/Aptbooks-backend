const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const { createAssetCategorySchema } = require("../../../shared/validators/assets.validators");
const svc = require("./assetCategories.service");

router.use(authRequired);

router.post("/", requirePermission("assets.categories.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createAssetCategorySchema, req.body);
    res.status(201).json(await svc.createCategory({ orgId, actorUserId, payload }));
  } catch (e) { next(e); }
});

router.get("/", requirePermission("assets.categories.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listCategories({ orgId }));
  } catch (e) { next(e); }
});

module.exports = router;
