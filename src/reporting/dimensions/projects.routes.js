const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./projects.service");

const router = express.Router();

router.get("/", requirePermission("reporting.projects.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.listProjects({ orgId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("reporting.projects.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createProject({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/:projectId/phases", requirePermission("reporting.projects.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createPhase({ orgId, projectId: req.params.projectId, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/:projectId/phases/:phaseId/tasks", requirePermission("reporting.projects.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createTask({
      orgId,
      projectId: req.params.projectId,
      phaseId: req.params.phaseId,
      actorUserId,
      req,
      ...req.body,
    });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
