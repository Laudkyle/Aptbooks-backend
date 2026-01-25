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

// Stage 2 workflow endpoints
router.post(
  "/:id/versions/:versionId/submit",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.submitVersion({ orgId, forecastId: req.params.id, versionId: req.params.versionId, actorUserId, req });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/versions/:versionId/approve",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.approveVersion({ orgId, forecastId: req.params.id, versionId: req.params.versionId, actorUserId, req });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/versions/:versionId/reject",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.rejectVersion({ orgId, forecastId: req.params.id, versionId: req.params.versionId, reason: req.body?.reason, actorUserId, req });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/versions/:versionId/copy",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const { newVersionNo, name, scenarioKey, probabilityWeight } = req.body || {};
      const data = await svc.copyVersion({
        orgId,
        forecastId: req.params.id,
        sourceVersionId: req.params.versionId,
        newVersionNo,
        name,
        scenarioKey,
        probabilityWeight,
        actorUserId,
        req,
      });
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// Comparisons
router.get(
  "/:id/compare",
  requirePermission("reporting.forecasts.read"),
  async (req, res, next) => {
    try {
      const { organization_id: orgId } = req.user;
      const { baseVersionId, compareVersionId, periodId } = req.query;
      const data = await svc.compareVersions({ orgId, forecastId: req.params.id, baseVersionId, compareVersionId, periodId });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/vs-budget",
  requirePermission("reporting.forecasts.read"),
  async (req, res, next) => {
    try {
      const { organization_id: orgId } = req.user;
      const { forecastVersionId, budgetVersionId, periodId } = req.query;
      const data = await svc.forecastVsBudget({ orgId, forecastVersionId, budgetVersionId, periodId });
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

// CSV import of forecast lines into the latest draft version (text/csv body)
router.post(
  "/:id/lines/import-csv",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  express.text({ type: ["text/csv", "application/csv", "text/plain"], limit: "5mb" }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.importLinesCsv({
        orgId,
        forecastId: req.params.id,
        versionId: undefined,
        csvText: req.body,
        actorUserId,
        req,
      });
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// CSV import of forecast lines into a specific version (text/csv body)
router.post(
  "/:id/versions/:versionId/lines/import-csv",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  express.text({ type: ["text/csv", "application/csv", "text/plain"], limit: "5mb" }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.importLinesCsv({
        orgId,
        forecastId: req.params.id,
        versionId: req.params.versionId,
        csvText: req.body,
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
