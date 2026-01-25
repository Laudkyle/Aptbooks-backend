const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./kpis.service");

const router = express.Router();

router.get("/definitions", requirePermission("reporting.kpis.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { limit, offset, status } = req.query;
    const data = await svc.listDefinitions({
      orgId,
      limit: limit ? Number(limit) : 100,
      offset: offset ? Number(offset) : 0,
      status,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/definitions", requirePermission("reporting.kpis.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const created = await svc.createDefinition({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

router.put("/definitions/:id", requirePermission("reporting.kpis.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const updated = await svc.updateDefinition({ orgId, actorUserId, req, id: req.params.id, patch: req.body });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

router.delete("/definitions/:id", requirePermission("reporting.kpis.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.archiveDefinition({ orgId, actorUserId, req, id: req.params.id });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/values", requirePermission("reporting.kpis.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId } = req.query;
    const { limit, offset } = req.query;
    const data = await svc.listValues({
      orgId,
      periodId: periodId || null,
      limit: limit ? Number(limit) : 200,
      offset: offset ? Number(offset) : 0,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/values/compute", requirePermission("reporting.kpis.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { periodId, kpiDefinitionIds, asOfDate } = req.body;
    const data = await svc.computeValues({ orgId, periodId, kpiDefinitionIds, asOfDate, actorUserId, req });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// KPI Targets/Thresholds
router.get("/definitions/:id/targets", requirePermission("reporting.kpis.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { includeArchived } = req.query;
    const data = await svc.listTargets({ orgId, kpiDefinitionId: req.params.id, includeArchived: includeArchived === "true" });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/definitions/:id/targets", requirePermission("reporting.kpis.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createTarget({ orgId, kpiDefinitionId: req.params.id, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

router.put("/targets/:targetId", requirePermission("reporting.kpis.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.updateTarget({ orgId, actorUserId, req, targetId: req.params.targetId, patch: req.body });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.delete("/targets/:targetId", requirePermission("reporting.kpis.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.archiveTarget({ orgId, actorUserId, req, targetId: req.params.targetId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});


// CSV import of KPI values (text/csv body)
// Required columns: kpiDefinitionId or kpiCode, periodId, value. Optional: asOfDate, metaJson
router.post(
  "/values/import-csv",
  requirePermission("reporting.kpis.manage"),
  idempotency({ required: true }),
  express.text({ type: ["text/csv", "application/csv", "text/plain"], limit: "5mb" }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: actorUserId } = req.user;
      const data = await svc.importValuesCsv({ orgId, actorUserId, req, csvText: req.body });
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
