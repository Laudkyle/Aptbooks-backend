const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
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

router.post("/bases", requirePermission("reporting.allocations.manage"), async (req, res, next) => {
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

router.post("/rules", requirePermission("reporting.allocations.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createRule({ orgId, actorUserId, req, ...req.body });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

// Compute allocations snapshot
router.post("/compute", requirePermission("reporting.allocations.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { ruleId, periodId } = req.body;
    const data = await svc.computeAndPersist({ orgId, ruleId, periodId, actorUserId, req });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
