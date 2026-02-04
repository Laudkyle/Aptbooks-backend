const router = require("express").Router();

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

const {
  createDebitNoteSchema,
  applyDebitNoteSchema
} = require("../../../shared/validators/transactions.validators");

const svc = require("./debitNotes.service");

router.use(authRequired);

router.post("/", requirePermission("transactions.debit_note.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createDebitNoteSchema, req.body);
    const created = await svc.createDraftDebitNote({ orgId, actorUserId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "debit_note.created",
      entityType: "debit_notes",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.get("/", requirePermission("transactions.debit_note.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listDebitNotes({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("transactions.debit_note.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getDebitNoteDetails({ orgId, id: req.params.id }));
  } catch (e) { next(e); }
});

router.post("/:id/issue", requirePermission("transactions.debit_note.issue"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await svc.issueDebitNote({ orgId, actorUserId, id: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "debit_note.issued",
      entityType: "debit_notes",
      entityId: out.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/apply", requirePermission("transactions.debit_note.apply"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(applyDebitNoteSchema, req.body);
    const out = await svc.applyDebitNote({ orgId, actorUserId, id: req.params.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "debit_note.applied",
      entityType: "debit_notes",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/void", requirePermission("transactions.debit_note.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const reason = (req.body && req.body.reason) ? String(req.body.reason) : null;
    const out = await svc.voidDebitNote({ orgId, actorUserId, id: req.params.id, reason });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "debit_note.voided",
      entityType: "debit_notes",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
