const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const {
  createFixedAssetSchema,
  updateFixedAssetSchema,
  acquireFixedAssetSchema,
  disposeFixedAssetSchema,
  assetTransferSchema,
  assetRevaluationSchema,
  assetImpairmentSchema,
} = require("../../../shared/validators/assets.validators");
const svc = require("./fixedAssets.service");

router.use(authRequired);

// Register
router.post("/", idempotency({ required: true }), requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createFixedAssetSchema, req.body);
    res.status(201).json(await svc.createAsset({ orgId, actorUserId, payload }));
  } catch (e) { next(e); }
});

router.get("/", requirePermission("assets.fixed_assets.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listAssets({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("assets.fixed_assets.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getAssetDetails({ orgId, assetId: req.params.id }));
  } catch (e) { next(e); }
});

router.put("/:id", requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(updateFixedAssetSchema, req.body);
    res.json(await svc.updateAsset({ orgId, actorUserId, assetId: req.params.id, payload, audit: req.audit }));
  } catch (e) { next(e); }
});

router.delete("/:id", requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.deleteDraftAsset({ orgId, actorUserId, assetId: req.params.id, audit: req.audit }));
  } catch (e) { next(e); }
});

// Lifecycle actions
router.post("/:id/acquire", idempotency({ required: true }), requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(acquireFixedAssetSchema, req.body);
    res.json(await svc.acquireAsset({ orgId, actorUserId, assetId: req.params.id, payload }));
  } catch (e) { next(e); }
});

router.post("/:id/retire", idempotency({ required: true }), requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.retireAsset({ orgId, actorUserId, assetId: req.params.id }));
  } catch (e) { next(e); }
});

router.post("/:id/dispose", idempotency({ required: true }), requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(disposeFixedAssetSchema, req.body);
    res.json(await svc.disposeAsset({ orgId, actorUserId, assetId: req.params.id, payload }));
  } catch (e) { next(e); }
});

// Transfers + valuation
router.post("/:id/transfer", idempotency({ required: true }), requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(assetTransferSchema, req.body);
    res.json(await svc.transferAsset({ orgId, actorUserId, assetId: req.params.id, payload, audit: req.audit }));
  } catch (e) { next(e); }
});

router.post("/:id/revalue", idempotency({ required: true }), requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(assetRevaluationSchema, req.body);
    res.json(await svc.revalueAsset({ orgId, actorUserId, assetId: req.params.id, payload, audit: req.audit }));
  } catch (e) { next(e); }
});

router.post("/:id/impair", idempotency({ required: true }), requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(assetImpairmentSchema, req.body);
    res.json(await svc.impairAsset({ orgId, actorUserId, assetId: req.params.id, payload, audit: req.audit }));
  } catch (e) { next(e); }
});

module.exports = router;
