const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./webhooks.service");

const router = express.Router();

router.get("/subscriptions", requirePermission("webhooks.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await svc.listSubscriptions({ orgId });
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

router.post("/subscriptions", requirePermission("webhooks.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.createSubscription({ orgId, payload: req.body || {}, actorUserId, req });
    res.status(201).json({ data });
  } catch (e) {
    next(e);
  }
});

router.post("/subscriptions/:id/disable", requirePermission("webhooks.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.disableSubscription({ orgId, id: req.params.id, actorUserId });
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

router.post("/subscriptions/:id/rotate-secret", requirePermission("webhooks.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await svc.rotateSecret({ orgId, id: req.params.id, actorUserId });
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

// Manual dispatch (no background worker)
router.post("/dispatch", requirePermission("webhooks.dispatch"), async (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 50);
    const data = await svc.dispatchPending({ limit });
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
