const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");

const {
  createBillSchema,
  voidBillSchema
} = require("../../../shared/validators/transactions.validators");

const svc = require("./bills.service");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

router.use(authRequired);

router.post("/preview/determine-taxes", requirePermission("transactions.bill.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createBillSchema, req.body);
    res.json(await svc.previewBillTaxes({ orgId, payload }));
  } catch (e) { next(e); }
});

router.post("/", idempotency({ required: true }), requirePermission("transactions.bill.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(createBillSchema, req.body);
    const created = await svc.createDraftBill({ orgId, actorUserId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "bill.created",
      entityType: "bills",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.get("/", requirePermission("transactions.bill.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listBills({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("transactions.bill.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getBillDetails({ orgId, billId: req.params.id, currentUserId: req.user.id }));
  } catch (e) { next(e); }
});

// -----------------------------------------------------------------------------
// Stage 5: Approval workflow (Tier 10 Documents)
// -----------------------------------------------------------------------------

router.post(
  "/:id/submit-for-approval",
  idempotency({ required: true }),
  requirePermission("transactions.bill.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const doc = await svc.submitBillForApproval({ orgId, actorUserId, billId: req.params.id });

      await writeAudit({
        organizationId: orgId,
        actorUserId,
        action: "bill.submitted_for_approval",
        entityType: "bills",
        entityId: req.params.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: doc
      });

      res.json(doc);
    } catch (e) { next(e); }
  }
);

router.post(
  "/:id/approve",
  idempotency({ required: true }),
  requirePermission("approvals.act"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const comment = req.body?.comment;
      const doc = await svc.approveBillWorkflow({ orgId, actorUserId, billId: req.params.id, comment });

      await writeAudit({
        organizationId: orgId,
        actorUserId,
        action: "bill.approved",
        entityType: "bills",
        entityId: req.params.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: doc
      });

      res.json(doc);
    } catch (e) { next(e); }
  }
);

router.post(
  "/:id/reject",
  idempotency({ required: true }),
  requirePermission("approvals.act"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const comment = req.body?.comment;
      const doc = await svc.rejectBillWorkflow({ orgId, actorUserId, billId: req.params.id, comment });

      await writeAudit({
        organizationId: orgId,
        actorUserId,
        action: "bill.rejected",
        entityType: "bills",
        entityId: req.params.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: doc
      });

      res.json(doc);
    } catch (e) { next(e); }
  }
);

router.post("/:id/issue", idempotency({ required: true }), requirePermission("transactions.bill.issue"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const out = await svc.issueBill({ orgId, actorUserId, billId: req.params.id });

    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/void", idempotency({ required: true }), requirePermission("transactions.bill.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(voidBillSchema, req.body || {});
    const out = await svc.voidBill({ orgId, actorUserId, billId: req.params.id, reason: body.reason });

    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
