const router = require("express").Router(); 

const { authRequired } = require("../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const { validate } = require("../../../shared/validators/validate"); 
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service"); 

const {
  createCreditNoteSchema,
  applyCreditNoteSchema
} = require("../../../shared/validators/transactions.validators"); 

const svc = require("./creditNotes.service"); 

router.use(authRequired); 

router.post("/", requirePermission("transactions.credit_note.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const payload = validate(createCreditNoteSchema, req.body); 
    const created = await svc.createDraftCreditNote({ orgId, actorUserId, payload }); 

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "credit_note.created",
      entityType: "credit_notes",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    }); 

    res.status(201).json(created); 
  } catch (e) { next(e);  }
}); 

router.get("/", requirePermission("transactions.credit_note.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.listCreditNotes({ orgId, query: req.query })); 
  } catch (e) { next(e);  }
}); 

router.get("/:id", requirePermission("transactions.credit_note.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.getCreditNoteDetails({ orgId, id: req.params.id })); 
  } catch (e) { next(e);  }
}); 

router.post("/:id/issue", requirePermission("transactions.credit_note.issue"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const out = await svc.issueCreditNote({ orgId, actorUserId, id: req.params.id }); 

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "credit_note.issued",
      entityType: "credit_notes",
      entityId: out.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    }); 

    res.json(out); 
  } catch (e) { next(e);  }
}); 

router.post("/:id/apply", requirePermission("transactions.credit_note.apply"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const payload = validate(applyCreditNoteSchema, req.body); 
    const out = await svc.applyCreditNote({ orgId, actorUserId, id: req.params.id, payload }); 

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "credit_note.applied",
      entityType: "credit_notes",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    }); 

    res.json(out); 
  } catch (e) { next(e);  }
}); 

router.post("/:id/void", requirePermission("transactions.credit_note.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const actorUserId = req.user.id; 
    const reason = (req.body && req.body.reason) ? String(req.body.reason) : null; 
    const out = await svc.voidCreditNote({ orgId, actorUserId, id: req.params.id, reason }); 

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "credit_note.voided",
      entityType: "credit_notes",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    }); 

    res.json(out); 
  } catch (e) { next(e);  }
}); 

module.exports = router; 
