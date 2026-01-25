const express = require("express"); 
const { requirePermission } = require("../../middleware/permission.middleware"); 
const { idempotency } = require("../../middleware/idempotency.middleware"); 
const svc = require("./centers.service"); 

const router = express.Router(); 

router.get("/:type", requirePermission("reporting.centers.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user; 
    const { type } = req.params; 
    const { status } = req.query; 
    const data = await svc.listCenters({ orgId, type, status }); 
    res.json({ data }); 
  } catch (err) {
    next(err); 
  }
}); 

router.get("/:type/:id/usage", requirePermission("reporting.centers.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user; 
    const { type, id } = req.params; 
    const data = await svc.usageForCenter({ orgId, type, id }); 
    res.json({ data }); 
  } catch (err) {
    next(err); 
  }
}); 

router.post("/:type", requirePermission("reporting.centers.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user; 
    const { type } = req.params; 
    const created = await svc.createCenter({ orgId, type, actorUserId, req, ...req.body }); 
    res.status(201).json({ data: created }); 
  } catch (err) {
    next(err); 
  }
}); 

router.put("/:type/:id", requirePermission("reporting.centers.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user; 
    const { type, id: centerId } = req.params; 
    const updated = await svc.updateCenter({ orgId, type, id: centerId, actorUserId, req, ...req.body }); 
    res.json({ data: updated }); 
  } catch (err) {
    next(err); 
  }
}); 

router.delete("/:type/:id", requirePermission("reporting.centers.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user; 
    const { type, id: centerId } = req.params; 
    await svc.archiveCenter({ orgId, type, id: centerId, actorUserId, req }); 
    res.status(204).send(); 
  } catch (err) {
    next(err); 
  }
}); 

module.exports = router; 
