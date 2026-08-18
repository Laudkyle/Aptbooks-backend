const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
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

// Create draft journal. Bind the HTTP idempotency key to the journal's DB key.
router.post("/", idempotency({ required: true }), requirePermission("accounting.journal.create"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(journalCreateSchema, req.body);
    if (payload.idempotencyKey && payload.idempotencyKey !== req.idempotency.key) {
      throw new AppError(409, "Body idempotencyKey must match Idempotency-Key header");
    }
    payload.idempotencyKey = req.idempotency.key;
    const out = await journalAPI.createDraftJournal({ orgId, actorUserId, payload });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

// Update draft header
router.patch("/:id", idempotency({ required: true }), requirePermission("accounting.journal.edit"), async (req, res, next) => {
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
router.put("/:id/lines", idempotency({ required: true }), requirePermission("accounting.journal.edit"), async (req, res, next) => {
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
router.post("/:id/lines", idempotency({ required: true }), requirePermission("accounting.journal.edit"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const line = validate(journalLineAddSchema, req.body);
    // Implemented as replace by appending; avoids exposing line ids as API contract in Phase 4.
    const current = await journalAPI.getJournalWithLines({ orgId, journalId: req.params.id });
    const lines = (current.lines || []).map((l) => ({
      accountId: l.account_id,
      description: l.description,
      debit: l.debit,
      credit: l.credit
    }));
    lines.push(line);

    const out = await journalAPI.replaceDraftLines({ orgId, journalId: req.params.id, actorUserId, lines, requireBalanced: false });
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
router.patch("/:id/lines/:lineNo", idempotency({ required: true }), requirePermission("accounting.journal.edit"), async (req, res, next) => {
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
      debit: l.debit,
      credit: l.credit
    }));

    if (lineNo > lines.length) throw new AppError(404, "Line not found");
    lines[lineNo - 1] = {
      ...lines[lineNo - 1],
      ...patch
    };

    const out = await journalAPI.replaceDraftLines({ orgId, journalId: req.params.id, actorUserId, lines, requireBalanced: false });
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
router.delete("/:id/lines/:lineNo", idempotency({ required: true }), requirePermission("accounting.journal.edit"), async (req, res, next) => {
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
        debit: l.debit,
        credit: l.credit
      }))
      .filter((_, idx) => idx !== lineNo - 1);

    const out = await journalAPI.replaceDraftLines({ orgId, journalId: req.params.id, actorUserId, lines, requireBalanced: false });
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

// Submit for approval. Audit persistence is inside the journal transaction.
router.post("/:id/submit", idempotency({ required: true }), requirePermission("accounting.journal.submit"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await journalAPI.submitDraftJournal({ orgId, journalId: req.params.id, actorUserId });

    res.json(out);
  } catch (e) { next(e); }
});

// Approve. Audit persistence is inside the journal transaction.
router.post("/:id/approve", idempotency({ required: true }), requirePermission("accounting.journal.approve"), async (req, res, next) => {
  try {
    const out = await journalAPI.approveSubmittedJournal({
      orgId: req.user.organization_id,
      journalId: req.params.id,
      actorUserId: req.user.id
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Reject. Audit persistence is inside the journal transaction.
router.post("/:id/reject", idempotency({ required: true }), requirePermission("accounting.journal.reject"), async (req, res, next) => {
  try {
    const payload = validate(journalRejectSchema, req.body);
    if (!payload.reason) throw new AppError(400, "reason required");
    const out = await journalAPI.rejectSubmittedJournal({
      orgId: req.user.organization_id,
      journalId: req.params.id,
      actorUserId: req.user.id,
      reason: payload.reason
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Cancel draft. Audit persistence is inside the journal transaction.
router.post("/:id/cancel", idempotency({ required: true }), requirePermission("accounting.journal.cancel"), async (req, res, next) => {
  try {
    const out = await journalAPI.cancelDraftJournal({
      orgId: req.user.organization_id,
      journalId: req.params.id,
      actorUserId: req.user.id
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Batch post
router.post("/batch/post", idempotency({ required: true }), requirePermission("accounting.journal.batch_post"), async (req, res, next) => {
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

// Post. The journal service writes its audit row in the same DB transaction.
router.post("/:id/post", idempotency({ required: true }), requirePermission("accounting.journal.post"), async (req, res, next) => {
  try {
    const out = await journalAPI.postDraftJournal({
      orgId: req.user.organization_id,
      journalId: req.params.id,
      actorUserId: req.user.id
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Void by reversal. Audit persistence is inside the same accounting transaction.
router.post("/:id/void", idempotency({ required: true }), requirePermission("accounting.journal.void"), async (req, res, next) => {
  try {
    const payload = validate(voidSchema, req.body);
    if (!payload.reason) throw new AppError(400, "reason required");
    const out = await journalAPI.voidPostedJournal({
      orgId: req.user.organization_id,
      journalId: req.params.id,
      actorUserId: req.user.id,
      reason: payload.reason
    });
    res.json(out);
  } catch (e) { next(e); }
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
