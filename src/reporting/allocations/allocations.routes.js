const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./allocations.service");

const router = express.Router();
const { resolveOrgId } = require("../_util");

// Bases
router.get("/bases", requirePermission("reporting.allocations.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const data = await svc.listBases({ orgId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/bases", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const data = await svc.createBase({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});


router.put("/bases/:id", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const data = await svc.updateBase({ orgId, id: req.params.id, actorUserId, req, ...req.body });
    res.json({ data });
  } catch (err) { next(err); }
});

router.patch("/bases/:id", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const data = await svc.updateBase({ orgId, id: req.params.id, actorUserId, req, ...req.body });
    res.json({ data });
  } catch (err) { next(err); }
});

router.delete("/bases/:id", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const data = await svc.archiveBase({ orgId, id: req.params.id, actorUserId, req });
    res.json({ data });
  } catch (err) { next(err); }
});

// Rules
router.get("/rules", requirePermission("reporting.allocations.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const data = await svc.listRules({ orgId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/rules", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const data = await svc.createRule({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});


router.put("/rules/:id", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const data = await svc.updateRule({ orgId, id: req.params.id, actorUserId, req, ...req.body });
    res.json({ data });
  } catch (err) { next(err); }
});

router.patch("/rules/:id", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const data = await svc.updateRule({ orgId, id: req.params.id, actorUserId, req, ...req.body });
    res.json({ data });
  } catch (err) { next(err); }
});

router.delete("/rules/:id", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const data = await svc.archiveRule({ orgId, id: req.params.id, actorUserId, req });
    res.json({ data });
  } catch (err) { next(err); }
});

// Preview allocations (no persistence)
router.post("/preview", requirePermission("reporting.allocations.manage"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { ruleIds, periodId } = req.body;
    const data = await svc.previewCompute({ orgId, ruleIds, periodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Compute allocations snapshot (persist)
router.post("/compute", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const { ruleIds, periodId, memo, replace } = req.body;
    const data = await svc.computeAndPersist({ orgId, ruleIds, periodId, memo, replace, actorUserId, req });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});


router.post("/:id/approve", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const data = await svc.approveAllocation({ orgId, allocationId: req.params.id, actorUserId, req });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/reject", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const data = await svc.rejectAllocation({ orgId, allocationId: req.params.id, reason: req.body?.reason, actorUserId, req });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/reverse", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const { entryDate, reason } = req.body || {};
    const data = await svc.reverseAllocation({ orgId, allocationId: req.params.id, entryDate, reason, actorUserId, req });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Post an approved allocation to the journal (creates a journal entry)
router.post("/:id/post", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const { id } = req.params;
    const { entryDate, memo } = req.body || {};
    const data = await svc.postAllocation({ orgId, allocationId: id, entryDate, memo, actorUserId, req });
    res.status(200).json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
