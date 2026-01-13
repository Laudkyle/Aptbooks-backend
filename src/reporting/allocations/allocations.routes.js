const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./allocations.service");

const router = express.Router();

// Bases
router.get("/bases", requirePermission("reporting.allocations.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.listBases({ orgId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/bases", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createBase({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// Rules
router.get("/rules", requirePermission("reporting.allocations.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.listRules({ orgId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/rules", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createRule({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// Compute allocations snapshot
router.post("/compute", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { ruleIds, periodId, memo, replace } = req.body;
    const data = await svc.computeAndPersist({ orgId, ruleIds, periodId, memo, replace, actorUserId, req });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// Post a computed allocation to the journal (creates a journal entry)
router.post("/:id/post", requirePermission("reporting.allocations.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { id } = req.params;
    const { entryDate, memo } = req.body || {};
    const data = await svc.postAllocation({ orgId, allocationId: id, entryDate, memo, actorUserId, req });
    res.status(200).json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
