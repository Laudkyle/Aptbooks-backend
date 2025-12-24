const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");

const {
  createBillSchema,
  voidBillSchema
} = require("../../../shared/validators/transactions.validators");

const svc = require("./bills.service");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

router.use(authRequired);

router.post("/", requirePermission("transactions.bill.manage"), async (req, res, next) => {
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
    res.json(await svc.getBillDetails({ orgId, billId: req.params.id }));
  } catch (e) { next(e); }
});

router.post("/:id/issue", requirePermission("transactions.bill.issue"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const out = await svc.issueBill({ orgId, actorUserId, billId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "bill.issued",
      entityType: "bills",
      entityId: out.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/void", requirePermission("transactions.bill.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(voidBillSchema, req.body || {});
    const out = await svc.voidBill({ orgId, actorUserId, billId: req.params.id, reason: body.reason });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "bill.voided",
      entityType: "bills",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
