const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./budgets.service");

const router = express.Router();

router.get("/", requirePermission("reporting.budgets.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.listBudgets({ orgId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("reporting.budgets.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const created = await svc.createBudget({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requirePermission("reporting.budgets.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.getBudget({ orgId, id: req.params.id });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requirePermission("reporting.budgets.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.updateBudget({ orgId, actorUserId, req, id: req.params.id, ...req.body });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Versions
router.post("/:id/versions", requirePermission("reporting.budgets.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createVersion({ orgId, budgetId: req.params.id, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/versions/:versionId/lines", requirePermission("reporting.budgets.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.upsertLines({
      orgId,
      budgetId: req.params.id,
      versionId: req.params.versionId,
      lines: req.body.lines || [],
      actorUserId,
      req,
    });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// Variance (Budget vs Actual)
// GET /reporting/budgets/:id/versions/:versionId/variance?periodId=<accounting_period_id>
router.get("/:id/versions/:versionId/variance", requirePermission("reporting.budgets.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId } = req.query;
    const data = await svc.getVariance({
      orgId,
      budgetId: req.params.id,
      versionId: req.params.versionId,
      periodId,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
