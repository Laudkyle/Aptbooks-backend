const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const { createPeriodSchema } = require("../../../shared/validators/accounting.validators");
const { AppError } = require("../../../shared/errors/AppError");
const periodAPI = require("../../../interfaces/periodManagement.interface");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");

router.use(authRequired);

router.post("/", requirePermission("accounting.period.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createPeriodSchema, req.body);
    const created = await periodAPI.createPeriod({ orgId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "period.created",
      entityType: "accounting_periods",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) {
    // Postgres exclusion constraint violation (period overlap)
    if (e && e.code === "23P01") {
      return next(new AppError(409, "Period dates overlap an existing period"));
    }
    next(e);
  }
});

// Read-only listing should not require manage permission
router.get("/", requirePermission("accounting.period.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await periodAPI.listPeriods({ orgId });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Explicit current period API
router.get("/current", requirePermission("accounting.period.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await periodAPI.getCurrentPeriod({ orgId });
    res.json(out);
  } catch (e) {
    next(e);
  }
});
router.get("/:id/close-preview", requirePermission("accounting.period.close"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await periodAPI.closePreview({ orgId, periodId: req.params.id });
    res.json(out);
  } catch (e) { next(e);}
});

router.post("/:id/close", requirePermission("accounting.period.close"), async (req, res, next) => {
  const force = req.body?.force === true;
  try {
    if (force) {
      // run middleware explicitly (proper error propagation)
      await new Promise((resolve, reject) => {
        requirePermission("accounting.period.force_close")(req, res, (err) => (err ? reject(err) : resolve()));
      });
    }

    const orgId = req.user.organization_id;

    const out = await periodAPI.closePeriod({
      orgId,
      periodId: req.params.id,
      actorUserId: req.user.id,
      options: { autoRunAccruals: req.body?.autoRunAccruals, force }
    });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "period.closed",
      entityType: "accounting_periods",
      entityId: out.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/reopen", requirePermission("accounting.period.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await periodAPI.reopenPeriod({ orgId, periodId: req.params.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "period.reopened",
      entityType: "accounting_periods",
      entityId: out.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/lock", requirePermission("accounting.period.lock"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await periodAPI.lockPeriod({ orgId, periodId: req.params.id, actorUserId: req.user.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "period.locked",
      entityType: "accounting_periods",
      entityId: out.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) { next(e);}
});

router.post("/:id/unlock", requirePermission("accounting.period.unlock"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await periodAPI.unlockPeriod({ orgId, periodId: req.params.id, actorUserId: req.user.id });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "period.unlocked",
      entityType: "accounting_periods",
      entityId: out.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) { next(e);}
});

router.post("/:id/roll-forward", requirePermission("accounting.period.roll_forward"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = req.body || {};
    const created = await periodAPI.rollForward({ orgId, periodId: req.params.id, actorUserId: req.user.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "period.rolled_forward",
      entityType: "accounting_periods",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) {
    if (e && e.code === "23P01") {
      return next(new AppError(409, "Period dates overlap an existing period"));
    }
    next(e);
  }
});

module.exports = router;
