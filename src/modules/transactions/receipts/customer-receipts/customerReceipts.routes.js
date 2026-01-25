const router = require("express").Router();
const { authRequired } = require("../../../../middleware/auth.middleware");
const { requirePermission } = require("../../../../middleware/permission.middleware");
const { validate } = require("../../../../shared/validators/validate");
const { writeAudit } = require("../../../../core/foundation/audit-logs/audit.service");

const {
  createCustomerReceiptSchema,
  voidCustomerReceiptSchema,
  reallocateCustomerReceiptSchema,
  autoAllocateCustomerReceiptSchema
} = require("../../../../shared/validators/transactions.validators");

const svc = require("./customerReceipts.service");

router.use(authRequired);

router.post("/", requirePermission("transactions.customer_receipt.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(createCustomerReceiptSchema, req.body);
    const created = await svc.createDraftCustomerReceipt({ orgId, actorUserId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "customer_receipt.created",
      entityType: "customer_receipts",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) { next(e);}
});

router.get("/", requirePermission("transactions.customer_receipt.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listCustomerReceipts({ orgId, query: req.query }));
  } catch (e) { next(e);}
});

router.get("/:id", requirePermission("transactions.customer_receipt.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getCustomerReceiptDetails({ orgId, id: req.params.id }));
  } catch (e) { next(e);}
});

router.post("/:id/auto-allocate", requirePermission("transactions.customer_receipt.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(autoAllocateCustomerReceiptSchema, req.body || {});
    const out = await svc.autoAllocateCustomerReceipt({ orgId, actorUserId, id: req.params.id, rule: body.rule });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "customer_receipt.auto_allocated",
      entityType: "customer_receipts",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e);}
});

router.post("/:id/reallocate", requirePermission("transactions.allocations.reallocate"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(reallocateCustomerReceiptSchema, req.body || {});
    const out = await svc.reallocateCustomerReceipt({ orgId, actorUserId, id: req.params.id, allocations: body.allocations });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "customer_receipt.reallocated",
      entityType: "customer_receipts",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e);}
});

router.post("/:id/post", requirePermission("transactions.customer_receipt.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const out = await svc.postCustomerReceipt({ orgId, actorUserId, id: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "customer_receipt.posted",
      entityType: "customer_receipts",
      entityId: out.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e);}
});

router.post("/:id/void", requirePermission("transactions.customer_receipt.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(voidCustomerReceiptSchema, req.body || {});
    const out = await svc.voidCustomerReceipt({ orgId, actorUserId, id: req.params.id, reason: body.reason });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "customer_receipt.voided",
      entityType: "customer_receipts",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e);}
});

module.exports = router;
