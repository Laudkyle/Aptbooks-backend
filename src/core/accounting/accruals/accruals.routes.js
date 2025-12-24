const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const {
  createAccrualRuleSchema,
  runDueAccrualsSchema,
  runPeriodEndAccrualsSchema
} = require("../../../shared/validators/accrual.validators");

const svc = require("./accruals.service");
const { writeAudit } = require("../../foundation/audit-logs/audit.service");

router.use(authRequired);

// Create accrual rule
router.post("/", requirePermission("accounting.accruals.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createAccrualRuleSchema, req.body);

    const created = await svc.createRule({ orgId, actorUserId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "accrual_rule.created",
      entityType: "accrual_rules",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) { next(e); }
});

// List rules
router.get("/", requirePermission("accounting.accruals.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listRules({ orgId }));
  } catch (e) { next(e); }
});

// Get rule + lines
router.get("/:id", requirePermission("accounting.accruals.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getRuleWithLines({ orgId, ruleId: req.params.id }));
  } catch (e) { next(e); }
});

// Run due accruals for a date
router.post("/run/due", requirePermission("accounting.accruals.run"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(runDueAccrualsSchema, req.body || {});
    const out = await svc.runDueAccruals({ orgId, actorUserId, asOfDate: body.asOfDate });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "accruals.run_due",
      entityType: "accrual_runs",
      entityId: null,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { asOfDate: body.asOfDate, count: out.length }
    });

    res.json(out);
  } catch (e) { next(e); }
});
router.post("/run/reversals", requirePermission("accounting.accruals.run"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const { periodId } = req.body || {};
    if (!periodId) return res.status(400).json({ error: "periodId required" });

    const out = await svc.runReversals({ orgId, actorUserId, periodId });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "accruals.run_reversals",
      entityType: "accrual_runs",
      entityId: periodId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: out
    });

    res.json(out);
  } catch (e) { next(e); }
});
// List runs (monitoring)
router.get("/runs", requirePermission("accounting.accruals.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listRuns({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

// Get one run (monitoring)
router.get("/runs/:runId", requirePermission("accounting.accruals.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getRun({ orgId, runId: req.params.runId }));
  } catch (e) { next(e); }
});

// Run period-end accruals for a period
router.post("/run/period-end", requirePermission("accounting.accruals.run"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;

    const body = validate(runPeriodEndAccrualsSchema, req.body || {});
    const out = await svc.runPeriodEndAccruals({
      orgId,
      actorUserId,
      periodId: body.periodId,
      asOfDateOverride: body.asOfDate
    });

    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "accruals.run_period_end",
      entityType: "accrual_runs",
      entityId: body.periodId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { periodId: body.periodId, count: out.length }
    });

    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
