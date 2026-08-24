const { createModuleBodyContract } = require("../../shared/http/requestValidation");
const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./centers.service");
const { AppError } = require('../../shared/errors/AppError');

const router = express.Router();
router.use(createModuleBodyContract(['comment']));
const { resolveOrgId } = require("../_util");

// Get all centers across all types (cost, profit, investment)
router.get("/all", requirePermission("reporting.centers.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { status, includeArchived, grouped } = req.query;
    
    // Parse boolean query parameters
    const parsedIncludeArchived = includeArchived === 'true';
    const parsedGrouped = grouped === 'true';
    
    let data;
    if (parsedGrouped) {
      // Return centers grouped by type
      data = await svc.getAllCentersGrouped({ 
        orgId, 
        status, 
        includeArchived: parsedIncludeArchived 
      });
    } else {
      // Return flat list of all centers
      data = await svc.getAllCenters({ 
        orgId, 
        status, 
        includeArchived: parsedIncludeArchived 
      });
    }
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Get centers by type (existing)
router.get("/:type", requirePermission("reporting.centers.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { type } = req.params;
    const { status } = req.query;
    const data = await svc.listCenters({ orgId, type, status });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Get center by ID across all types (auto-detects type)
router.get("/by-id/:id", requirePermission("reporting.centers.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { id } = req.params;
    const data = await svc.getCenterById({ orgId, id });
    
    if (!data) {
      throw new AppError(404, "The selected center could not be found.", { id }, "center_not_found");
    }
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Get usage for a center by ID (auto-detects type)
router.get("/by-id/:id/usage", requirePermission("reporting.centers.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { id } = req.params;
    const data = await svc.getCenterUsage({ orgId, id });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Get usage for a center by type and ID (existing)
router.get("/:type/:id/usage", requirePermission("reporting.centers.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { type, id } = req.params;
    const data = await svc.usageForCenter({ orgId, type, id });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Create center (existing)
router.post("/:type", requirePermission("reporting.centers.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const { type } = req.params;
    const created = await svc.createCenter({ orgId, type, actorUserId, req, ...req.body });
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

// Update center (existing)
router.put("/:type/:id", requirePermission("reporting.centers.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const { type, id: centerId } = req.params;
    const updated = await svc.updateCenter({ orgId, type, id: centerId, actorUserId, req, ...req.body });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

// Archive center (existing)
router.delete("/:type/:id", requirePermission("reporting.centers.manage"), idempotency({ required: true }), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const actorUserId = req.user?.id;
    const { type, id: centerId } = req.params;
    await svc.archiveCenter({ orgId, type, id: centerId, actorUserId, req });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;