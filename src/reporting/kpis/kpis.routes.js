const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./kpis.service");

const router = express.Router();

router.get("/definitions", requirePermission("reporting.kpis.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.listDefinitions({ orgId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/definitions", requirePermission("reporting.kpis.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const created = await svc.createDefinition({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

router.put("/definitions/:id", requirePermission("reporting.kpis.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const updated = await svc.updateDefinition({ orgId, actorUserId, req, id: req.params.id, ...req.body });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

router.delete("/definitions/:id", requirePermission("reporting.kpis.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    await svc.deleteDefinition({ orgId, actorUserId, req, id: req.params.id });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.get("/values", requirePermission("reporting.kpis.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId } = req.query;
    const data = await svc.computeValues({ orgId, periodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/values/compute", requirePermission("reporting.kpis.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { periodId } = req.body;
    const data = await svc.computeAndPersistValues({ orgId, periodId, actorUserId, req });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
