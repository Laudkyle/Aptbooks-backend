const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./reportBuilder.service");

const router = express.Router();
const { resolveOrgId } = require("../_util");

function ctx(req) {
  return {
    organizationId: resolveOrgId(req),
    userId: req.user.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  };
}

// List/create reports
router.get(
  "/",
  requirePermission("reporting.reports.read"),
  async (req, res, next) => {
    try {
      const rows = await svc.listReports(ctx(req), {
        includeArchived: req.query.includeArchived === "true",
        search: req.query.search || null,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ data: rows });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const out = await svc.createReport(ctx(req), req.body || {});
      res.status(201).json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.patch(
  "/:reportId",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const out = await svc.updateReportMeta(ctx(req), req.params.reportId, req.body || {});
      res.json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/:reportId/archive",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const out = await svc.archiveReport(ctx(req), req.params.reportId, true);
      res.json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/:reportId/unarchive",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const out = await svc.archiveReport(ctx(req), req.params.reportId, false);
      res.json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

// Versions
router.get(
  "/:reportId/versions",
  requirePermission("reporting.reports.read"),
  async (req, res, next) => {
    try {
      const out = await svc.listVersions(ctx(req), req.params.reportId);
      res.json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/:reportId/versions",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const out = await svc.createVersion(ctx(req), req.params.reportId, req.body || {});
      res.status(201).json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

// Runs
router.post(
  "/:reportId/run",
  requirePermission("reporting.reports.read"),
  async (req, res, next) => {
    try {
      const out = await svc.runReport(ctx(req), req.params.reportId, req.body || {});
      res.json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/:reportId/runs",
  requirePermission("reporting.reports.read"),
  async (req, res, next) => {
    try {
      const out = await svc.listRuns(ctx(req), req.params.reportId, req.query.limit);
      res.json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

// Shares
router.get(
  "/:reportId/shares",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const out = await svc.listShares(ctx(req), req.params.reportId);
      res.json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/:reportId/shares",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const out = await svc.upsertShare(ctx(req), req.params.reportId, req.body || {});
      res.status(201).json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  "/shares/:shareId",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const ok = await svc.deleteShare(ctx(req), req.params.shareId);
      res.json({ data: { ok } });
    } catch (e) {
      next(e);
    }
  }
);

// Schedules
router.get(
  "/:reportId/schedules",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const out = await svc.listSchedules(ctx(req), req.params.reportId);
      res.json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/:reportId/schedules",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const out = await svc.createSchedule(ctx(req), req.params.reportId, req.body || {});
      res.status(201).json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.patch(
  "/schedules/:scheduleId",
  requirePermission("reporting.reports.manage"),
  idempotency({ required: true }),
  async (req, res, next) => {
    try {
      const out = await svc.updateSchedule(ctx(req), req.params.scheduleId, req.body || {});
      res.json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

// Comments
router.get(
  "/:reportId/comments",
  requirePermission("reporting.reports.read"),
  async (req, res, next) => {
    try {
      const out = await svc.listComments(ctx(req), req.params.reportId, req.query.limit);
      res.json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/:reportId/comments",
  requirePermission("reporting.reports.read"),
  async (req, res, next) => {
    try {
      const out = await svc.addComment(ctx(req), req.params.reportId, req.body?.body);
      res.status(201).json({ data: out });
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
