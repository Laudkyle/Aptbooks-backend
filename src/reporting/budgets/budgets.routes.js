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


// Distribute annual amounts across periods (standard budgeting helper)
// POST /reporting/budgets/:id/versions/:versionId/distribute
// body: { items: [{ accountId, annualAmount, method: 'even'|'weighted'|'custom', periodIds?, weights?, amounts?, dimensionJson? }] }
router.post(
  "/:id/versions/:versionId/distribute",
  requirePermission("reporting.budgets.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.distributeAnnual({
        orgId,
        budgetId: req.params.id,
        versionId: req.params.versionId,
        items: req.body.items || [],
        actorUserId,
        req,
      });
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// Finalize a draft budget version (locks it for edits)
// POST /reporting/budgets/:id/versions/:versionId/finalize
router.post(
  "/:id/versions/:versionId/finalize",
  requirePermission("reporting.budgets.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.finalizeVersion({
        orgId,
        budgetId: req.params.id,
        versionId: req.params.versionId,
        actorUserId,
        req,
      });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// Stage 2 workflow endpoints
router.post(
  "/:id/versions/:versionId/submit",
  requirePermission("reporting.budgets.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.submitVersion({ orgId, budgetId: req.params.id, versionId: req.params.versionId, actorUserId, req });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/versions/:versionId/approve",
  requirePermission("reporting.budgets.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.approveVersion({ orgId, budgetId: req.params.id, versionId: req.params.versionId, actorUserId, req });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/versions/:versionId/reject",
  requirePermission("reporting.budgets.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.rejectVersion({
        orgId,
        budgetId: req.params.id,
        versionId: req.params.versionId,
        reason: req.body?.reason,
        actorUserId,
        req,
      });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/versions/:versionId/copy",
  requirePermission("reporting.budgets.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.copyVersion({
        orgId,
        budgetId: req.params.id,
        sourceVersionId: req.params.versionId,
        newVersionNo: req.body?.newVersionNo,
        name: req.body?.name,
        scenarioKey: req.body?.scenarioKey,
        actorUserId,
        req,
      });
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/versions/:versionId/mass-adjust",
  requirePermission("reporting.budgets.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const { pct, accountId, periodId, dimensionJson } = req.body || {};
      const data = await svc.massAdjustLines({
        orgId,
        budgetId: req.params.id,
        versionId: req.params.versionId,
        pct,
        accountId,
        periodId,
        dimensionJson,
        actorUserId,
        req,
      });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// Budget alert rules
router.get("/:id/alerts", requirePermission("reporting.budgets.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.listAlertRules({ orgId, budgetId: req.params.id });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/alerts", requirePermission("reporting.budgets.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createAlertRule({ orgId, budgetId: req.params.id, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

router.put(
  "/:id/alerts/:ruleId",
  requirePermission("reporting.budgets.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.updateAlertRule({ orgId, budgetId: req.params.id, ruleId: req.params.ruleId, patch: req.body, actorUserId, req });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

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
