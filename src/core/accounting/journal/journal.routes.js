const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const {
  journalCreateSchema,
  voidSchema
} = require("../../../shared/validators/accounting.validators");
const { AppError } = require("../../../shared/errors/AppError");

const svc = require("./journal.service");
const { pool } = require("../../../db/pool");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");

router.use(authRequired);

// Create draft journal (validated + auditable)
router.post("/", requirePermission("accounting.journal.create"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(journalCreateSchema, req.body);

    const out = await svc.createDraftJournal({ orgId, actorUserId, payload });

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

// Post journal (auditable)
router.post("/:id/post", requirePermission("accounting.journal.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const { rows: beforeRows } = await pool.query(
      `SELECT * FROM journal_entries WHERE organization_id=$1 AND id=$2`,
      [orgId, req.params.id]
    );
    const before = beforeRows[0] || null;

    const out = await svc.postDraftJournal({ orgId, journalId: req.params.id, actorUserId });

    const { rows: afterRows } = await pool.query(
      `SELECT * FROM journal_entries WHERE organization_id=$1 AND id=$2`,
      [orgId, req.params.id]
    );
    const after = afterRows[0] || null;

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
// NOTE: Phase 1 policy: reversal must be in SAME period and that period must be OPEN (enforced in service)
router.post("/:id/void", requirePermission("accounting.journal.void"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const payload = validate(voidSchema, req.body);
    if (!payload.reason) throw new AppError(400, "reason required");

    const out = await svc.voidByReversal({
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

    const { rows: j } = await pool.query(
      `SELECT * FROM journal_entries WHERE organization_id=$1 AND id=$2`,
      [orgId, req.params.id]
    );
    if (!j.length) return res.status(404).json({ error: "Not found" });

    const { rows: lines } = await pool.query(
      `SELECT * FROM journal_entry_lines WHERE journal_entry_id=$1 ORDER BY line_no`,
      [req.params.id]
    );

    res.json({ journal: j[0], lines });
  } catch (e) {
    next(e);
  }
});

// Optional: list journals with basic filters (handy for Phase 1)
router.get("/", requirePermission("accounting.journal.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { periodId, status, from, to } = req.query;

    const params = [orgId];
    const where = ["organization_id=$1"];
    let i = 2;

    if (periodId) { where.push(`period_id=$${i++}`); params.push(periodId); }
    if (status) { where.push(`status=$${i++}`); params.push(status); }
    if (from) { where.push(`entry_date >= $${i++}`); params.push(from); }
    if (to) { where.push(`entry_date <= $${i++}`); params.push(to); }

    const { rows } = await pool.query(
      `SELECT * FROM journal_entries WHERE ${where.join(" AND ")} ORDER BY entry_no DESC`,
      params
    );

    res.json(rows);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
