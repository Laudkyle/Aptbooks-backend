const router = require("express").Router();
const { authRequired } = require("../../../../middleware/auth.middleware");
const { requirePermission } = require("../../../../middleware/permission.middleware");
const { validate } = require("../../../../shared/validators/validate");

const {
  createVendorPaymentSchema,
  voidVendorPaymentSchema
} = require("../../../../shared/validators/transactions.validators");

const svc = require("./vendorPayments.service");
const { writeAudit } = require("../../../../core/foundation/audit-logs/audit.service");

router.use(authRequired);

router.post("/", requirePermission("transactions.vendor_payment.manage"), async (req, res, next) => {
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

router.get("/", requirePermission("transactions.vendor_payment.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listVendorPayments({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("transactions.vendor_payment.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getVendorPaymentDetails({ orgId, id: req.params.id }));
  } catch (e) { next(e); }
});

router.post("/:id/post", requirePermission("transactions.vendor_payment.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const out = await svc.postVendorPayment({ orgId, actorUserId, id: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "vendor_payment.posted",
      entityType: "vendor_payments",
      entityId: out.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/void", requirePermission("transactions.vendor_payment.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(voidVendorPaymentSchema, req.body || {});
    const out = await svc.voidVendorPayment({ orgId, actorUserId, id: req.params.id, reason: body.reason });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "vendor_payment.voided",
      entityType: "vendor_payments",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
