const express = require("express");
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const { validate } = require("../../shared/validators/validate");

const svc = require("./ifrs16.service");
const v = require("./ifrs16.validators");

const router = express.Router();

// All IFRS16 routes are authenticated.
router.use(authRequired);

/**
 * Leases
 */
router.get(
  "/leases",
  requirePermission("compliance.ifrs16.read"),
  async (req, res, next) => {
    try {
      const data = await svc.listLeases({
        orgId: req.user.organization_id,
        query: req.query,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/leases",
  requirePermission("compliance.ifrs16.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.createLease, req.body);
      const lease = await svc.createLease({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.status(201).json(lease);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/leases/:leaseId",
  requirePermission("compliance.ifrs16.read"),
  async (req, res, next) => {
    try {
      const params = validate(v.leaseIdParam, req.params);
      const lease = await svc.getLease({
        orgId: req.user.organization_id,
        leaseId: params.leaseId,
      });
      res.json(lease);
    } catch (err) {
      next(err);
    }
  }
);

// Lifecycle: update lease status (draft/active/terminated/closed)
router.patch(
  "/leases/:leaseId/status",
  requirePermission("compliance.ifrs16.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.leaseIdParam, req.params);
      const payload = validate(v.updateStatus, { ...req.body, ...params });
      const result = await svc.updateLeaseStatus({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        leaseId: params.leaseId,
        payload,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/leases/:leaseId/schedule/generate",
  requirePermission("compliance.ifrs16.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.leaseIdParam, req.params);
      const payload = validate(v.generateSchedule, { ...req.body, ...params });
      const result = await svc.generateSchedule({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        leaseId: params.leaseId,
        payload,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/leases/:leaseId/schedule",
  requirePermission("compliance.ifrs16.read"),
  async (req, res, next) => {
    try {
      const params = validate(v.leaseIdParam, req.params);
      const result = await svc.getSchedule({
        orgId: req.user.organization_id,
        leaseId: params.leaseId,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/leases/:leaseId/post",
  requirePermission("compliance.ifrs16.post"),
  async (req, res, next) => {
    try {
      const params = validate(v.leaseIdParam, req.params);
      const payload = validate(v.postLease, { ...req.body, ...params });
      const result = await svc.postLeasePeriod({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        leaseId: params.leaseId,
        payload,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// Initial recognition: Dr ROU asset / Cr Lease liability
router.post(
  "/leases/:leaseId/initial-recognition/post",
  requirePermission("compliance.ifrs16.post"),
  async (req, res, next) => {
    try {
      const params = validate(v.leaseIdParam, req.params);
      const payload = validate(v.postInitialRecognition, { ...req.body, ...params });
      const result = await svc.postInitialRecognition({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        leaseId: params.leaseId,
        payload,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
