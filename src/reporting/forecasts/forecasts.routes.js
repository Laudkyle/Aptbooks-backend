const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./forecasts.service");
const { AppError } = require('../../shared/errors/AppError');
const notificationsSvc = require("../../notifications/notifications.service");

const router = express.Router();

// ============================
// Scenario Management Routes
// ============================

// GET all scenarios
router.get("/scenarios", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { includeInactive } = req.query;
    
    const data = await svc.listScenarios({ 
      orgId, 
      includeInactive: includeInactive === 'true' 
    });
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET scenarios with usage statistics
router.get("/scenarios/stats", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    
    const data = await svc.getScenariosWithStats({ orgId });
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET a specific scenario by ID
router.get("/scenarios/:scenarioId", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    
    const data = await svc.getScenario({ 
      orgId, 
      scenarioId: req.params.scenarioId 
    });
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET a scenario by code
router.get("/scenarios/code/:code", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    
    const data = await svc.getScenarioByCode({ 
      orgId, 
      code: req.params.code 
    });
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// CREATE a new scenario
router.post(
  "/scenarios",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      
      const data = await svc.createScenario({ 
        orgId, 
        actorUserId, 
        req, 
        ...req.body 
      });
      
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// UPDATE a scenario (PUT)
router.put(
  "/scenarios/:scenarioId",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      
      if (Object.keys(req.body).length === 0) {
        throw new AppError(400, "Please change at least one field before saving.", undefined, "empty_update");
      }
      
      const data = await svc.updateScenario({
        orgId,
        scenarioId: req.params.scenarioId,
        patch: req.body,
        actorUserId,
        req
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// UPDATE a scenario (PATCH)
router.patch(
  "/scenarios/:scenarioId",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      
      if (Object.keys(req.body).length === 0) {
        throw new AppError(400, "Please change at least one field before saving.", undefined, "empty_update");
      }
      
      const data = await svc.updateScenario({
        orgId,
        scenarioId: req.params.scenarioId,
        patch: req.body,
        actorUserId,
        req
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE a scenario (soft delete or hard delete based on usage)
router.delete(
  "/scenarios/:scenarioId",
  requirePermission("reporting.forecasts.manage"),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const { force } = req.query; // Optional query param to force hard delete
      
      const data = await svc.deleteScenario({ 
        orgId, 
        scenarioId: req.params.scenarioId,
        actorUserId,
        req,
        force: force === 'true'
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// SET a scenario as default
router.post(
  "/scenarios/:scenarioId/set-default",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      
      const data = await svc.setDefaultScenario({
        orgId,
        scenarioId: req.params.scenarioId,
        actorUserId,
        req
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// RESTORE a soft-deleted scenario
router.post(
  "/scenarios/:scenarioId/restore",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      
      const data = await svc.restoreScenario({
        orgId,
        scenarioId: req.params.scenarioId,
        actorUserId,
        req
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// ============================
// Existing Forecast Routes
// ============================

// GET endpoint for listing forecasts
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

// GET single forecast by ID with all versions and lines
router.get("/:id", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { includeLines } = req.query;
    
    const data = await svc.getForecast({ 
      orgId, 
      forecastId: req.params.id, 
      actorUserId, 
      req,
      includeLines: includeLines === 'true'
    });
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// UPDATE forecast (PUT)
router.put("/:id", 
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      
      if (Object.keys(req.body).length === 0) {
        throw new AppError(400, "Please change at least one field before saving.", undefined, "empty_update");
      }
      
      const data = await svc.updateForecast({
        orgId,
        forecastId: req.params.id,
        patch: req.body,
        actorUserId,
        req
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// UPDATE forecast (PATCH)
router.patch("/:id", 
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      
      if (Object.keys(req.body).length === 0) {
        throw new AppError(400, "Please change at least one field before saving.", undefined, "empty_update");
      }
      
      const data = await svc.updateForecast({
        orgId,
        forecastId: req.params.id,
        patch: req.body,
        actorUserId,
        req
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET a specific forecast version with its lines
router.get("/:id/versions/:versionId", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    
    const data = await svc.getForecastVersion({ 
      orgId, 
      forecastId: req.params.id, 
      versionId: req.params.versionId,
      actorUserId, 
      req
    });
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET all versions for a forecast
router.get("/:id/versions", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    
    const versions = await svc.listForecastVersions({ 
      orgId, 
      forecastId: req.params.id
    });
    
    res.json({ data: versions });
  } catch (err) {
    next(err);
  }
});

// UPDATE forecast version (PUT)
router.put("/:id/versions/:versionId",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      
      if (Object.keys(req.body).length === 0) {
        throw new AppError(400, "Please change at least one field before saving.", undefined, "empty_update");
      }
      
      const data = await svc.updateForecastVersion({
        orgId,
        forecastId: req.params.id,
        versionId: req.params.versionId,
        patch: req.body,
        actorUserId,
        req
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// UPDATE forecast version (PATCH)
router.patch("/:id/versions/:versionId",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      
      if (Object.keys(req.body).length === 0) {
        throw new AppError(400, "Please change at least one field before saving.", undefined, "empty_update");
      }
      
      const data = await svc.updateForecastVersion({
        orgId,
        forecastId: req.params.id,
        versionId: req.params.versionId,
        patch: req.body,
        actorUserId,
        req
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET lines for a specific version
router.get("/:id/versions/:versionId/lines", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { limit, offset, accountId, periodId } = req.query;
    
    const lines = await svc.listForecastLines({ 
      orgId, 
      forecastId: req.params.id,
      versionId: req.params.versionId,
      limit: limit ? Number(limit) : 100,
      offset: offset ? Number(offset) : 0,
      accountId: accountId || undefined,
      periodId: periodId || undefined
    });
    
    res.json({ data: lines });
  } catch (err) {
    next(err);
  }
});

// GET forecast summary with key metrics
router.get("/:id/summary", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    
    const summary = await svc.getForecastSummary({ 
      orgId, 
      forecastId: req.params.id
    });
    
    res.json({ data: summary });
  } catch (err) {
    next(err);
  }
});

// GET workflow history for a forecast version
router.get("/:id/versions/:versionId/history", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    
    const history = await svc.getVersionWorkflowHistory({ 
      orgId, 
      forecastId: req.params.id,
      versionId: req.params.versionId
    });
    
    res.json({ data: history });
  } catch (err) {
    next(err);
  }
});

// POST endpoints
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

// Versions endpoints
router.post(
  "/:id/versions",
  requirePermission("reporting.forecasts.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.createVersion({ 
        orgId, 
        forecastId: req.params.id, 
        actorUserId, 
        req, 
        ...req.body 
      });
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
      const data = await svc.submitVersion({ 
        orgId, 
        forecastId: req.params.id, 
        versionId: req.params.versionId, 
        actorUserId, 
        req 
      });

      await notificationsSvc.createNotification({
        orgId,
        actorUserId,
        payload: {
          type: "approval",
          severity: "info",
          title: "Forecast submitted for approval",
          body: `A forecast version has been submitted and is awaiting approval. (Forecast ID: ${req.params.id}, Version ID: ${req.params.versionId})`,
          entityType: "forecast_versions",
          entityId: req.params.versionId
        }
      });

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
      const data = await svc.approveVersion({ 
        orgId, 
        forecastId: req.params.id, 
        versionId: req.params.versionId, 
        actorUserId, 
        req 
      });
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
      const data = await svc.rejectVersion({ 
        orgId, 
        forecastId: req.params.id, 
        versionId: req.params.versionId, 
        reason: req.body?.reason, 
        actorUserId, 
        req 
      });
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
      const { newVersionNo, name, scenarioId, probabilityWeight } = req.body || {};
      
      const data = await svc.copyVersion({
        orgId,
        forecastId: req.params.id,
        sourceVersionId: req.params.versionId,
        newVersionNo,
        name,
        scenarioId,
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
      
      const data = await svc.compareVersions({ 
        orgId, 
        forecastId: req.params.id, 
        baseVersionId, 
        compareVersionId, 
        periodId 
      });
      
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
      
      const data = await svc.forecastVsBudget({ 
        orgId, 
        forecastVersionId, 
        budgetVersionId, 
        periodId 
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

// CSV import of forecast lines into the latest draft version
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

// CSV import of forecast lines into a specific version
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
router.get("/:id/variance", requirePermission("reporting.forecasts.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, versionId } = req.query;
    
    const data = await svc.getVariance({ 
      orgId, 
      forecastId: req.params.id, 
      versionId, 
      periodId 
    });
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;