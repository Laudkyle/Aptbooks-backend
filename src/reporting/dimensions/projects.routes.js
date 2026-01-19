const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./projects.service");

const router = express.Router();

router.get("/", requirePermission("reporting.projects.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { limit, offset, status } = req.query;
    const data = await svc.listProjects({
      orgId,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      status,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/:projectId", requirePermission("reporting.projects.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.getProject({ orgId, id: req.params.projectId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("reporting.projects.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createProject({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// Phases
router.post("/:projectId/phases", requirePermission("reporting.projects.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createPhase({ orgId, projectId: req.params.projectId, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/:projectId/phases", requirePermission("reporting.projects.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.listPhases({ orgId, projectId: req.params.projectId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.put("/:projectId/phases/:phaseId", requirePermission("reporting.projects.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.updatePhase({
      orgId,
      projectId: req.params.projectId,
      id: req.params.phaseId,
      actorUserId,
      req,
      ...req.body,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.delete("/:projectId/phases/:phaseId", requirePermission("reporting.projects.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    await svc.archivePhase({ orgId, projectId: req.params.projectId, id: req.params.phaseId, actorUserId, req });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Tasks
router.post("/:projectId/phases/:phaseId/tasks", requirePermission("reporting.projects.manage"), idempotency({ required: true }), async (req, res, next) => {
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

router.get("/:projectId/phases/:phaseId/tasks", requirePermission("reporting.projects.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.listTasks({ orgId, projectId: req.params.projectId, phaseId: req.params.phaseId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.put("/:projectId/phases/:phaseId/tasks/:taskId", requirePermission("reporting.projects.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.updateTask({
      orgId,
      projectId: req.params.projectId,
      phaseId: req.params.phaseId,
      id: req.params.taskId,
      actorUserId,
      req,
      ...req.body,
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.delete("/:projectId/phases/:phaseId/tasks/:taskId", requirePermission("reporting.projects.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    await svc.archiveTask({
      orgId,
      projectId: req.params.projectId,
      phaseId: req.params.phaseId,
      id: req.params.taskId,
      actorUserId,
      req,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Project lifecycle
router.put("/:projectId", requirePermission("reporting.projects.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.updateProject({ orgId, id: req.params.projectId, actorUserId, req, ...req.body });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.delete("/:projectId", requirePermission("reporting.projects.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    await svc.archiveProject({ orgId, id: req.params.projectId, actorUserId, req });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
