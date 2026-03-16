const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./stockCounts.service");
const notificationsSvc = require("../../../notifications/notifications.service");

router.use(authRequired);

router.get("/", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    res.json(await svc.listStockCounts({ orgId: req.user.organization_id, query: req.query }));
  } catch (e) { next(e); }
});

router.post("/", idempotency({ required: true }), requirePermission("inventory.transactions.manage"), async (req, res, next) => {
  try {
    const result = await svc.createStockCount({ orgId: req.user.organization_id, actorUserId: req.user.id, payload: req.body });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    res.json(await svc.getStockCount({ orgId: req.user.organization_id, id: req.params.id }));
  } catch (e) { next(e); }
});

router.post("/:id/lines", idempotency({ required: true }), requirePermission("inventory.transactions.manage"), async (req, res, next) => {
  try {
    res.json(await svc.upsertLines({ orgId: req.user.organization_id, actorUserId: req.user.id, id: req.params.id, payload: req.body }));
  } catch (e) { next(e); }
});

router.post("/:id/submit", idempotency({ required: true }), requirePermission("inventory.transactions.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await svc.submitStockCount({ orgId, actorUserId, id: req.params.id });

    await notificationsSvc.createNotification({
      orgId,
      actorUserId,
      payload: {
        type: "approval",
        severity: "info",
        title: "Stock count submitted for approval",
        body: `A stock count has been submitted and is awaiting approval. (Stock Count ID: ${req.params.id})`,
        entityType: "inventory_stock_counts",
        entityId: req.params.id
      }
    });

    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/approve", idempotency({ required: true }), requirePermission("inventory.transactions.approve"), async (req, res, next) => {
  try {
    res.json(await svc.approveStockCountWorkflow({ orgId: req.user.organization_id, actorUserId: req.user.id, id: req.params.id, comment: req.body?.comment }));
  } catch (e) { next(e); }
});

router.post("/:id/reject", idempotency({ required: true }), requirePermission("inventory.transactions.approve"), async (req, res, next) => {
  try {
    res.json(await svc.rejectStockCountWorkflow({ orgId: req.user.organization_id, actorUserId: req.user.id, id: req.params.id, comment: req.body?.comment }));
  } catch (e) { next(e); }
});

router.post("/:id/post", idempotency({ required: true }), requirePermission("inventory.transactions.post"), async (req, res, next) => {
  try {
    res.json(await svc.postStockCountAdjustments({ orgId: req.user.organization_id, actorUserId: req.user.id, id: req.params.id, payload: req.body || {} }));
  } catch (e) { next(e); }
});

module.exports = router;
