const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

const svc = require("./invoices.service");
const {
  createInvoiceSchema,
  listInvoicesQuerySchema,
  voidInvoiceSchema
} = require("../../../shared/validators/transactions/invoices.validators");

router.use(authRequired);

router.post("/", requirePermission("transactions.invoice.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createInvoiceSchema, req.body);
    const created = await svc.createDraftInvoice({ orgId, actorUserId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "invoice.draft_created",
      entityType: "invoices",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.get("/", requirePermission("transactions.invoice.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const query = validate(listInvoicesQuerySchema, req.query);
    res.json(await svc.listInvoices({ orgId, query }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("transactions.invoice.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getInvoiceDetails({ orgId, invoiceId: req.params.id }));
  } catch (e) { next(e); }
});

router.post("/:id/issue", requirePermission("transactions.invoice.issue"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const issued = await svc.issueInvoice({ orgId, actorUserId, invoiceId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "invoice.issued",
      entityType: "invoices",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: issued
    });

    res.json(issued);
  } catch (e) { next(e); }
});

router.post("/:id/void", requirePermission("transactions.invoice.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(voidInvoiceSchema, req.body);

    const out = await svc.voidInvoice({
      orgId, actorUserId, invoiceId: req.params.id, reason: payload.reason
    });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "invoice.voided",
      entityType: "invoices",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
