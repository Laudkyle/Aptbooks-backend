const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require("express").Router();
router.use(createModuleBodyContract(['comment', 'createdBy', 'destWarehouseId', 'idempotencyKey', 'lines', 'memo', 'periodId', 'reason', 'reference', 'sourceWarehouseId', 'txnDate', 'txnType']));
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./transactions.service");
const { validate } = require("../../../shared/validators/validate");
const { createInventoryTransactionSchema } = require("../../../shared/validators/inventory.validators");

router.use(authRequired);

router.get("/", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listTransactions({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

router.get("/cost-method", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    res.json(await svc.ensureCostMethod(req.user.organization_id));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("inventory.transactions.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getTransaction({ orgId, transactionId: req.params.id }));
  } catch (e) { next(e); }
});

router.post("/", idempotency({ required: true }), requirePermission("inventory.transactions.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const result = await svc.createDraftTransaction({ orgId, actorUserId, payload: validate(createInventoryTransactionSchema, req.body) });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

router.post("/:id/submit", idempotency({ required: true }), requirePermission("inventory.transactions.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.submitTransactionForApproval({ orgId, actorUserId, transactionId: req.params.id }));
  } catch (e) { next(e); }
});

router.post("/:id/approve", idempotency({ required: true }), requirePermission("inventory.transactions.approve"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.approveTransactionWorkflow({ orgId, actorUserId, transactionId: req.params.id, comment: req.body?.comment }));
  } catch (e) { next(e); }
});

router.post("/:id/reject", idempotency({ required: true }), requirePermission("inventory.transactions.approve"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.rejectTransactionWorkflow({ orgId, actorUserId, transactionId: req.params.id, comment: req.body?.comment }));
  } catch (e) { next(e); }
});

router.post("/:id/post", idempotency({ required: true }), requirePermission("inventory.transactions.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.status(201).json(await svc.postApprovedTransaction({ orgId, actorUserId, transactionId: req.params.id }));
  } catch (e) { next(e); }
});

router.post("/:id/void", idempotency({ required: true }), requirePermission("inventory.transactions.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.voidTransaction({ orgId, actorUserId, transactionId: req.params.id, reason: req.body?.reason }));
  } catch (e) { next(e); }
});

router.post("/:id/reverse", idempotency({ required: true }), requirePermission("inventory.transactions.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.reversePostedTransaction({ orgId, actorUserId, transactionId: req.params.id, reason: req.body?.reason }));
  } catch (e) { next(e); }
});

module.exports = router;
