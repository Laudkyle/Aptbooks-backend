const express = require("express");
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const { validate } = require("../../shared/validators/validate");

const svc = require("./ias12.service");
const v = require("../../shared/validators/ias12.validators");

const router = express.Router();

// All IAS12 routes are authenticated.
router.use(authRequired);

router.get(
  "/health",
  requirePermission("compliance.ias12.read"),
  (_req, res) => res.json({ ok: true, module: "ias12" })
);

// -----------------
// Authorities
// -----------------

router.get(
  "/authorities",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const data = await svc.listAuthorities({ orgId: req.user.organization_id });
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/authorities",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.createAuthority, req.body);
      const authority = await svc.createAuthority({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.status(201).json(authority);
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/authorities/:authorityId",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.authorityIdParam, req.params);
      const payload = validate(v.updateAuthority, { ...req.body, ...params });
      const authority = await svc.updateAuthority({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        authorityId: params.authorityId,
        payload,
      });
      res.json(authority);
    } catch (err) {
      next(err);
    }
  }
);

// -----------------
// Rate sets + lines
// -----------------

router.get(
  "/rate-sets",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const data = await svc.listRateSets({ orgId: req.user.organization_id });
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/rate-sets",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.createRateSet, req.body);
      const rateSet = await svc.createRateSet({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.status(201).json(rateSet);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/rate-sets/:rateSetId/lines",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.rateSetIdParam, req.params);
      const payload = validate(v.addRateLine, { ...req.body, ...params });
      const line = await svc.addRateLine({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        rateSetId: params.rateSetId,
        payload,
      });
      res.status(201).json(line);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/rate-sets/:rateSetId/lines",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const params = validate(v.rateSetIdParam, req.params);
      const lines = await svc.listRateLines({
        orgId: req.user.organization_id,
        rateSetId: params.rateSetId,
      });
      res.json(lines);
    } catch (err) {
      next(err);
    }
  }
);

// -----------------
// Settings
// -----------------

router.get(
  "/settings",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const settings = await svc.getSettings({ orgId: req.user.organization_id });
      res.json(settings);
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  "/settings",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.upsertSettings, req.body);
      const settings = await svc.upsertSettings({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.json(settings);
    } catch (err) {
      next(err);
    }
  }
);

// -----------------
// Temp difference categories
// -----------------

router.get(
  "/temp-difference-categories",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const data = await svc.listTempDifferenceCategories({ orgId: req.user.organization_id });
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/temp-difference-categories",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.createTempDifferenceCategory, req.body);
      const cat = await svc.createTempDifferenceCategory({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.status(201).json(cat);
    } catch (err) {
      next(err);
    }
  }
);

// -----------------
// Temporary differences
// -----------------

router.get(
  "/temp-differences",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const q = validate(v.periodIdQuery, req.query);
      const data = await svc.listTempDifferences({
        orgId: req.user.organization_id,
        periodId: q.period_id,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/temp-differences",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.createTempDifference, req.body);
      const td = await svc.createTempDifference({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.status(201).json(td);
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/temp-differences/:tempDifferenceId",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.tempDifferenceIdParam, req.params);
      const payload = validate(v.updateTempDifference, { ...req.body, ...params });
      const td = await svc.updateTempDifference({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        tempDifferenceId: params.tempDifferenceId,
        payload,
      });
      res.json(td);
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/temp-differences/:tempDifferenceId",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.tempDifferenceIdParam, req.params);
      const result = await svc.deleteTempDifference({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        tempDifferenceId: params.tempDifferenceId,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);


// -----------------
// Temp differences imports / copy-forward
// -----------------

router.post(
  "/temp-differences/import",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.importTempDifferences, req.body);
      const out = await svc.importTempDifferences({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/temp-differences/copy-forward",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.copyForwardTempDifferences, req.body);
      const out = await svc.copyForwardTempDifferences({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  }
);

// -----------------
// Reports
// -----------------

router.get(
  "/reports/roll-forward",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const q = validate(v.periodIdQuery, req.query);
      const out = await svc.getRollForwardReport({ orgId: req.user.organization_id, periodId: q.period_id });
      res.json(out);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/reports/by-category",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const q = validate(v.periodIdQuery, req.query);
      const out = await svc.getCategoryBreakdownReport({ orgId: req.user.organization_id, periodId: q.period_id });
      res.json(out);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/reports/unrecognised",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const q = validate(v.periodIdQuery, req.query);
      const out = await svc.getUnrecognisedDtaReport({ orgId: req.user.organization_id, periodId: q.period_id });
      res.json(out);
    } catch (err) {
      next(err);
    }
  }
);

// -----------------
// Deferred tax compute + runs + posting
// -----------------

router.post(
  "/deferred-tax/compute",
  requirePermission("compliance.ias12.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.computeDeferredTax, req.body);
      const run = await svc.computeDeferredTax({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.status(201).json(run);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/deferred-tax/runs",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const q = req.query.period_id ? validate(v.periodIdQuery, req.query) : null;
      const runs = await svc.listDeferredTaxRuns({
        orgId: req.user.organization_id,
        periodId: q ? q.period_id : null,
      });
      res.json(runs);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/deferred-tax/runs/:runId",
  requirePermission("compliance.ias12.read"),
  async (req, res, next) => {
    try {
      const params = validate(v.runIdParam, req.params);
      const run = await svc.getDeferredTaxRun({
        orgId: req.user.organization_id,
        runId: params.runId,
      });
      res.json(run);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/deferred-tax/runs/:runId/finalize",
  requirePermission("compliance.ias12.post"),
  async (req, res, next) => {
    try {
      const params = validate(v.runIdParam, req.params);
      const result = await svc.finalizeDeferredTaxRun({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        runId: params.runId,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/deferred-tax/post",
  requirePermission("compliance.ias12.post"),
  async (req, res, next) => {
    try {
      const payload = validate(v.postDeferredTax, req.body);
      const posted = await svc.postDeferredTax({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.json(posted);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/deferred-tax/reverse",
  requirePermission("compliance.ias12.post"),
  async (req, res, next) => {
    try {
      const payload = validate(v.reverseDeferredTax, req.body);
      const result = await svc.reverseDeferredTaxPosting({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
