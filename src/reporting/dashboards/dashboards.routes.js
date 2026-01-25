const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./dashboards.service");

const router = express.Router();

function ctx(req) {
  return {
    organizationId: req.user.organization_id,
    userId: req.user.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  };
}

router.get(
  "/",
  requirePermission("reporting.dashboards.read"),
  async (req, res, next) => {
    try {
      const out = await svc.listDashboards(ctx(req), {
        includeArchived: req.query.includeArchived === "true",
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ data: out });
    } catch (e) { next(e);}
  }
);

router.post(
  "/",
  requirePermission("reporting.dashboards.manage"),
  async (req, res, next) => {
    try {
      const out = await svc.createDashboard(ctx(req), req.body || {});
      res.status(201).json({ data: out });
    } catch (e) { next(e);}
  }
);

router.patch(
  "/:dashboardId",
  requirePermission("reporting.dashboards.manage"),
  async (req, res, next) => {
    try {
      const out = await svc.updateDashboard(ctx(req), req.params.dashboardId, req.body || {});
      res.json({ data: out });
    } catch (e) { next(e);}
  }
);

// Widgets
router.get(
  "/:dashboardId/widgets",
  requirePermission("reporting.dashboards.read"),
  async (req, res, next) => {
    try {
      const out = await svc.listWidgets(ctx(req), req.params.dashboardId, req.query.includeArchived === "true");
      res.json({ data: out });
    } catch (e) { next(e);}
  }
);

router.post(
  "/:dashboardId/widgets",
  requirePermission("reporting.dashboards.manage"),
  async (req, res, next) => {
    try {
      const out = await svc.createWidget(ctx(req), req.params.dashboardId, req.body || {});
      res.status(201).json({ data: out });
    } catch (e) { next(e);}
  }
);

router.patch(
  "/widgets/:widgetId",
  requirePermission("reporting.dashboards.manage"),
  async (req, res, next) => {
    try {
      const out = await svc.updateWidget(ctx(req), req.params.widgetId, req.body || {});
      res.json({ data: out });
    } catch (e) { next(e);}
  }
);

module.exports = router;
