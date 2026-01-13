const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./forecasts.service");

const router = express.Router();

router.get("/", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { limit, offset, status } = req.query;
    const data = await svc.listForecasts({
      orgId,
      limit: limit ? Number(limit) : 100,
      offset: offset ? Number(offset) : 0,
      status: status || undefined,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.createForecast({ orgId, actorUserId, req, ...req.body });
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/activate",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.activateForecast({ orgId, forecastId: req.params.id, actorUserId, req });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/archive",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.archiveForecast({ orgId, forecastId: req.params.id, actorUserId, req });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// Versions (standard accounting practice)
router.post(
  "/:id/versions",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.createVersion({ orgId, forecastId: req.params.id, actorUserId, req, ...req.body });
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/versions/:versionId/finalize",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.finalizeVersion({
        orgId,
        forecastId: req.params.id,
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

// Upsert lines into the latest draft version
router.post(
  "/:id/lines",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.upsertLines({
        orgId,
        forecastId: req.params.id,
        versionId: undefined,
        lines: req.body.lines || [],
        actorUserId,
        req,
      });
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// Upsert lines into a specific version
router.post(
  "/:id/versions/:versionId/lines",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.upsertLines({
        orgId,
        forecastId: req.params.id,
        versionId: req.params.versionId,
        lines: req.body.lines || [],
        actorUserId,
        req,
      });
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// Variance (Forecast vs Actual)
// GET /reporting/forecasts/:id/variance?periodId=<period>&versionId=<optional>
router.get("/:id/variance", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, versionId } = req.query;
    const data = await svc.getVariance({ orgId, forecastId: req.params.id, versionId, periodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
