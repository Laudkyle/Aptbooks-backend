const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const {
  journalCreateSchema,
  journalHeaderUpdateSchema,
  journalLinesReplaceSchema,
  journalLineAddSchema,
  journalLineUpdateSchema,
  journalRejectSchema,
  journalBatchPostSchema,
  voidSchema
} = require("../../../shared/validators/accounting.validators");
const { AppError } = require("../../../shared/errors/AppError");

const journalAPI = require("../../../interfaces/journalPosting.interface");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");

router.use(authRequired);

// Create draft journal (validated + auditable)
router.post("/", requirePermission("accounting.journal.create"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(journalCreateSchema, req.body);
    const out = await journalAPI.createDraftJournal({ orgId, actorUserId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.created",
      entityType: "journal_entries",
      entityId: out.journalId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { ...payload, journalId: out.journalId }
    });

    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

// Update draft header
router.patch("/:id", requirePermission("accounting.journal.edit"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(journalHeaderUpdateSchema, req.body);
    const before = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const out = await journalAPI.updateDraftHeader({ orgId, journalId: req.params.id, actorUserId, payload });
    const after = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.updated",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before,
      after
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Replace all draft lines
router.put("/:id/lines", requirePermission("accounting.journal.edit"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(journalLinesReplaceSchema, req.body);
    const before = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const out = await journalAPI.replaceDraftLines({ orgId, journalId: req.params.id, actorUserId, lines: payload.lines });
    const after = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.lines.replaced",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before,
      after
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Add a draft line (convenience)
router.post("/:id/lines", requirePermission("accounting.journal.edit"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const line = validate(journalLineAddSchema, req.body);
    // Implemented as replace by appending; avoids exposing line ids as API contract in Phase 4.
    const current = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const lines = (current.lines || []).map((l) => ({
      accountId: l.account_id,
      description: l.description,
      debit: Number(l.debit),
      credit: Number(l.credit)
    }));
    lines.push(line);

    const out = await journalAPI.replaceDraftLines({ orgId, journalId: req.params.id, actorUserId, lines });
    const after = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.line.added",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Update a draft line by line number (1-based)
router.patch("/:id/lines/:lineNo", requirePermission("accounting.journal.edit"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const patch = validate(journalLineUpdateSchema, req.body);
    const lineNo = Number(req.params.lineNo);
    if (!Number.isInteger(lineNo) || lineNo < 1) throw new AppError(400, "Invalid lineNo");

    const current = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const lines = (current.lines || []).map((l) => ({
      accountId: l.account_id,
      description: l.description,
      debit: Number(l.debit),
      credit: Number(l.credit)
    }));

    if (lineNo > lines.length) throw new AppError(404, "Line not found");
    lines[lineNo - 1] = {
      ...lines[lineNo - 1],
      ...patch
    };

    const out = await journalAPI.replaceDraftLines({ orgId, journalId: req.params.id, actorUserId, lines });
    const after = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.line.updated",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: current,
      after
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Delete a draft line by line number (1-based)
router.delete("/:id/lines/:lineNo", requirePermission("accounting.journal.edit"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const lineNo = Number(req.params.lineNo);
    if (!Number.isInteger(lineNo) || lineNo < 1) throw new AppError(400, "Invalid lineNo");

    const current = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const lines = (current.lines || [])
      .map((l) => ({
        accountId: l.account_id,
        description: l.description,
        debit: Number(l.debit),
        credit: Number(l.credit)
      }))
      .filter((_, idx) => idx !== lineNo - 1);

    const out = await journalAPI.replaceDraftLines({ orgId, journalId: req.params.id, actorUserId, lines });
    const after = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.line.deleted",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: current,
      after
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Submit for approval
router.post("/:id/submit", requirePermission("accounting.journal.submit"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const before = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const out = await journalAPI.submitDraftJournal({ orgId, journalId: req.params.id, actorUserId });
    const after = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.submitted",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before,
      after
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Approve
router.post("/:id/approve", requirePermission("accounting.journal.approve"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const before = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const out = await journalAPI.approveSubmittedJournal({ orgId, journalId: req.params.id, actorUserId });
    const after = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.approved",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before,
      after
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Reject
router.post("/:id/reject", requirePermission("accounting.journal.reject"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(journalRejectSchema, req.body);
    if (!payload.reason) throw new AppError(400, "reason required");

    const before = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const out = await journalAPI.rejectSubmittedJournal({ orgId, journalId: req.params.id, actorUserId, reason: payload.reason });
    const after = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.rejected",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before,
      after
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Cancel draft
router.post("/:id/cancel", requirePermission("accounting.journal.cancel"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const before = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const out = await journalAPI.cancelDraftJournal({ orgId, journalId: req.params.id, actorUserId });
    const after = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.canceled",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before,
      after
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Batch post
router.post("/batch/post", requirePermission("accounting.journal.batch_post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(journalBatchPostSchema, req.body);
    const out = await journalAPI.batchPostJournals({ orgId, actorUserId, journalIds: payload.journalIds });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.batch_post",
      entityType: "journal_entries",
      entityId: null,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Post (auditable)
router.post("/:id/post", requirePermission("accounting.journal.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const before = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const out = await journalAPI.postDraftJournal({ orgId, journalId: req.params.id, actorUserId });
    const after = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.posted",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before,
      after
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Void by reversal (validated + auditable)
router.post("/:id/void", requirePermission("accounting.journal.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(voidSchema, req.body);
    if (!payload.reason) throw new AppError(400, "reason required");

    const out = await journalAPI.voidPostedJournal({
      orgId,
      journalId: req.params.id,
      actorUserId,
      reason: payload.reason
    });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "journal.voided_by_reversal",
      entityType: "journal_entries",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Read journal + lines
router.get("/:id", requirePermission("accounting.journal.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// List journals with basic filters
router.get("/", requirePermission("accounting.journal.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await journalAPI.listJournals({
      orgId,
      filters: {
        periodId: req.query.periodId,
        status: req.query.status,
        from: req.query.from,
        to: req.query.to
      }
    });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
