const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./forecasts.service");

const router = express.Router();

router.get("/", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.listForecasts({ orgId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("reporting.forecasts.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createForecast({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/lines", requirePermission("reporting.forecasts.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.upsertLines({
      orgId,
      forecastId: req.params.id,
      lines: req.body.lines || [],
      actorUserId,
      req,
    });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// Variance (Forecast vs Actual)
// GET /reporting/forecasts/:id/variance?periodId=<accounting_period_id>
router.get("/:id/variance", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId } = req.query;
    const data = await svc.getVariance({ orgId, forecastId: req.params.id, periodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
