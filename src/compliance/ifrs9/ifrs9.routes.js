const express = require("express");
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const { validate } = require("../../shared/validators/validate");

const svc = require("./ifrs9.service");
const v = require("./ifrs9.validators");

const router = express.Router();

router.use(authRequired);

// --------------------------------------
// Settings
// --------------------------------------

router.get(
  "/settings",
  requirePermission("compliance.ifrs9.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const out = await svc.getIfrs9Settings({ orgId });
      res.json(out || null);
    } catch (e) {
      next(e);
    }
  }
);

router.put(
  "/settings",
  requirePermission("compliance.ifrs9.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.upsertSettingsSchema, req.body);
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await svc.upsertIfrs9Settings({ orgId, actorUserId, payload });
      res.json(out);
    } catch (e) {
      next(e);
    }
  }
);

// --------------------------------------
// ECL Models
// --------------------------------------

router.get(
  "/ecl-models",
  requirePermission("compliance.ifrs9.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const out = await svc.listEclModels({ orgId });
      res.json(out);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/ecl-models",
  requirePermission("compliance.ifrs9.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.createModelSchema, req.body);
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await svc.createEclModel({ orgId, actorUserId, payload });
      res.status(201).json(out);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/ecl-models/:modelId/buckets",
  requirePermission("compliance.ifrs9.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.addBucketSchema, req.body);
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await svc.addEclBucket({ orgId, actorUserId, modelId: req.params.modelId, payload });
      res.status(201).json(out);
    } catch (e) {
      next(e);
    }
  }
);

// --------------------------------------
// Stage 2: General approach inputs
// --------------------------------------

router.put(
  "/counterparties/profile",
  requirePermission("compliance.ifrs9.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.upsertCounterpartyProfileSchema, req.body);
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await svc.upsertCounterpartyProfile({ orgId, actorUserId, payload });
      res.json(out);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/counterparties/:businessPartnerId/profile",
  requirePermission("compliance.ifrs9.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const out = await svc.getCounterpartyProfile({ orgId, businessPartnerId: req.params.businessPartnerId });
      res.json(out || null);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/ecl-models/:modelId/parameters",
  requirePermission("compliance.ifrs9.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.addParameterSchema, req.body);
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await svc.addEclParameter({ orgId, actorUserId, modelId: req.params.modelId, payload });
      res.status(201).json(out);
    } catch (e) {
      next(e);
    }
  }
);

// --------------------------------------
// Runs
// --------------------------------------

router.post(
  "/ecl/compute",
  requirePermission("compliance.ifrs9.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.computeEclSchema, req.body);
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await svc.computeEcl({ orgId, actorUserId, payload });
      res.status(201).json(out);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/ecl/runs",
  requirePermission("compliance.ifrs9.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const out = await svc.listRuns({ orgId, periodId: req.query.period_id || null });
      res.json(out);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/ecl/runs/:runId",
  requirePermission("compliance.ifrs9.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const out = await svc.getRunDetails({ orgId, runId: req.params.runId });
      res.json(out);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/ecl/runs/:runId/finalize",
  requirePermission("compliance.ifrs9.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await svc.finalizeRun({ orgId, actorUserId, runId: req.params.runId });
      res.json(out);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/ecl/post",
  requirePermission("compliance.ifrs9.post"),
  async (req, res, next) => {
    try {
      const payload = validate(v.postEclSchema, req.body);
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await svc.postEcl({ orgId, actorUserId, payload });
      res.json(out);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/ecl/reverse",
  requirePermission("compliance.ifrs9.post"),
  async (req, res, next) => {
    try {
      const payload = validate(v.reverseEclSchema, req.body);
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const out = await svc.reverseEclPosting({ orgId, actorUserId, payload });
      res.json(out);
    } catch (e) {
      next(e);
    }
  }
);

// --------------------------------------
// Reports (Disclosures)
// --------------------------------------

router.get(
  "/reports/allowance-movement",
  requirePermission("compliance.ifrs9.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const periodId = req.query.period_id;
      const out = await svc.getAllowanceMovementReport({ orgId, periodId });
      res.json(out);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/reports/disclosures",
  requirePermission("compliance.ifrs9.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const runId = req.query.run_id;
      const out = await svc.getDisclosuresReport({ orgId, runId });
      res.json(out);
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
