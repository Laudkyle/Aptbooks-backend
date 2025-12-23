const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const { createPeriodSchema } = require("../../../shared/validators/accounting.validators");
const svc = require("./periods.service");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");

router.use(authRequired);

router.post("/", requirePermission("accounting.period.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createPeriodSchema, req.body);
    const created = await svc.createPeriod({ orgId, payload });

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
    // handle overlap constraint more readably
    if (String(e.message || "").includes("no_period_overlap")) {
      e.status = 409;
      e.message = "Period dates overlap an existing period";
    }
    next(e);
  }
});

router.get("/", requirePermission("accounting.period.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.listPeriods({ orgId });
    res.json(out);
  } catch (e) { next(e); }
});

router.post("/:id/close", requirePermission("accounting.period.close"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.closePeriod({ orgId, periodId: req.params.id });

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
  } catch (e) { next(e); }
});

router.post("/:id/reopen", requirePermission("accounting.period.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.reopenPeriod({ orgId, periodId: req.params.id });

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
  } catch (e) { next(e); }
});

module.exports = router;
