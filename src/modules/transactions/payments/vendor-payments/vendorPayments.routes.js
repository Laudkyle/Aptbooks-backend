const router = require("express").Router();
const { authRequired } = require("../../../../middleware/auth.middleware");
const { requirePermission } = require("../../../../middleware/permission.middleware");
const { idempotency } = require("../../../../middleware/idempotency.middleware");
const { validate } = require("../../../../shared/validators/validate");

const {
  createVendorPaymentSchema,
  voidVendorPaymentSchema,
  reallocateVendorPaymentSchema,
  autoAllocateVendorPaymentSchema
} = require("../../../../shared/validators/transactions.validators");

const svc = require("./vendorPayments.service");
const { writeAudit } = require("../../../../core/foundation/audit-logs/audit.service");

router.use(authRequired);

router.post("/", idempotency({ required: true }), requirePermission("transactions.vendor_payment.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(createVendorPaymentSchema, req.body);
    const created = await svc.createDraftVendorPayment({ orgId, actorUserId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "vendor_payment.created",
      entityType: "vendor_payments",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.put("/:id", idempotency({ required: true }), requirePermission("transactions.vendor_payment.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createVendorPaymentSchema, req.body);
    res.json(await svc.updateDraftVendorPayment({ orgId, actorUserId, id: req.params.id, payload }));
  } catch (e) { next(e); }
});

router.get("/", requirePermission("transactions.vendor_payment.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listVendorPayments({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("transactions.vendor_payment.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getVendorPaymentDetails({ orgId, id: req.params.id, currentUserId: req.user.id }));
  } catch (e) { next(e); }
});

router.post("/:id/auto-allocate", idempotency({ required: true }), requirePermission("transactions.vendor_payment.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(autoAllocateVendorPaymentSchema, req.body || {});
    const out = await svc.autoAllocateVendorPayment({ orgId, actorUserId, id: req.params.id, rule: body.rule });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "vendor_payment.auto_allocated",
      entityType: "vendor_payments",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/reallocate", idempotency({ required: true }), requirePermission("transactions.allocations.reallocate"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(reallocateVendorPaymentSchema, req.body || {});
    const out = await svc.reallocateVendorPayment({ orgId, actorUserId, id: req.params.id, allocations: body.allocations });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "vendor_payment.reallocated",
      entityType: "vendor_payments",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});


router.post("/:id/submit-for-approval", idempotency({ required: true }), requirePermission("transactions.vendor_payment.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const doc = await svc.submitVendorPaymentForApproval({ orgId, actorUserId, id: req.params.id });
    await writeAudit({ organizationId: orgId, actorUserId, action: "vendor_payment.submitted_for_approval", entityType: "vendor_payments", entityId: req.params.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: doc });
    res.json(doc);
  } catch (e) { next(e); }
});

router.post("/:id/approve", idempotency({ required: true }), requirePermission("approvals.act"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const comment = req.body?.comment;
    const doc = await svc.approveVendorPaymentWorkflow({ orgId, actorUserId, id: req.params.id, comment });
    await writeAudit({ organizationId: orgId, actorUserId, action: "vendor_payment.approved", entityType: "vendor_payments", entityId: req.params.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: doc });
    res.json(doc);
  } catch (e) { next(e); }
});

router.post("/:id/reject", idempotency({ required: true }), requirePermission("approvals.act"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const comment = req.body?.comment;
    const doc = await svc.rejectVendorPaymentWorkflow({ orgId, actorUserId, id: req.params.id, comment });
    await writeAudit({ organizationId: orgId, actorUserId, action: "vendor_payment.rejected", entityType: "vendor_payments", entityId: req.params.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: doc });
    res.json(doc);
  } catch (e) { next(e); }
});

router.post("/:id/post", idempotency({ required: true }), requirePermission("transactions.vendor_payment.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const out = await svc.postVendorPayment({ orgId, actorUserId, id: req.params.id });

    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/void", idempotency({ required: true }), requirePermission("transactions.vendor_payment.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(voidVendorPaymentSchema, req.body || {});
    const out = await svc.voidVendorPayment({ orgId, actorUserId, id: req.params.id, reason: body.reason });

    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
