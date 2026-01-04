const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./centers.service");

const router = express.Router();

router.get("/:type", requirePermission("reporting.centers.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { type } = req.params;
    const data = await svc.list({ orgId, type });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/:type", requirePermission("reporting.centers.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { type } = req.params;
    const created = await svc.create({ orgId, type, actorUserId, req, ...req.body });
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

router.put("/:type/:id", requirePermission("reporting.centers.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { type, id: centerId } = req.params;
    const updated = await svc.update({ orgId, type, id: centerId, actorUserId, req, ...req.body });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

router.delete("/:type/:id", requirePermission("reporting.centers.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { type, id: centerId } = req.params;
    await svc.remove({ orgId, type, id: centerId, actorUserId, req });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
