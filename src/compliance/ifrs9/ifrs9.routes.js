
const express = require("express");
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const { validate } = require("../../shared/validators/validate");

const svc = require("./ifrs9.service");
const v = require("./ifrs9.validators");

const router = express.Router();
router.use(authRequired);

router.get("/settings", requirePermission("compliance.ifrs9.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.getIfrs9Settings({ orgId });
    res.json(out || null);
  } catch (e) { next(e); }
});

router.put("/settings", requirePermission("compliance.ifrs9.manage"), async (req, res, next) => {
  try {
    const payload = validate(v.upsertSettingsSchema, req.body);
    const out = await svc.upsertIfrs9Settings({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.get("/ecl-models", requirePermission("compliance.ifrs9.read"), async (req, res, next) => {
  try {
    const out = await svc.listEclModels({ orgId: req.user.organization_id });
    res.json(out);
  } catch (e) { next(e); }
});

router.post("/ecl-models", requirePermission("compliance.ifrs9.manage"), async (req, res, next) => {
  try {
    const payload = validate(v.createModelSchema, req.body);
    const out = await svc.createEclModel({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.post("/ecl-models/:modelId/buckets", requirePermission("compliance.ifrs9.manage"), async (req, res, next) => {
  try {
    const payload = validate(v.addBucketSchema, req.body);
    const out = await svc.addEclBucket({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      modelId: req.params.modelId,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.put("/counterparties/profile", requirePermission("compliance.ifrs9.manage"), async (req, res, next) => {
  try {
    const payload = validate(v.upsertCounterpartyProfileSchema, req.body);
    const out = await svc.upsertCounterpartyProfile({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.get("/counterparties/:businessPartnerId/profile", requirePermission("compliance.ifrs9.read"), async (req, res, next) => {
  try {
    const out = await svc.getCounterpartyProfile({ orgId: req.user.organization_id, businessPartnerId: req.params.businessPartnerId });
    res.json(out || null);
  } catch (e) { next(e); }
});

router.post("/ecl-models/:modelId/parameters", requirePermission("compliance.ifrs9.manage"), async (req, res, next) => {
  try {
    const payload = validate(v.addParameterSchema, req.body);
    const out = await svc.addEclParameter({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      modelId: req.params.modelId,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.post("/ecl/compute", requirePermission("compliance.ifrs9.manage"), async (req, res, next) => {
  try {
    const payload = validate(v.computeEclSchema, req.body);
    const out = await svc.computeEcl({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.get("/ecl/runs", requirePermission("compliance.ifrs9.read"), async (req, res, next) => {
  try {
    const out = await svc.listRuns({ orgId: req.user.organization_id, periodId: req.query.period_id || null });
    res.json(out);
  } catch (e) { next(e); }
});

router.get("/ecl/runs/:runId", requirePermission("compliance.ifrs9.read"), async (req, res, next) => {
  try {
    const out = await svc.getRunDetails({ orgId: req.user.organization_id, runId: req.params.runId });
    res.json(out);
  } catch (e) { next(e); }
});

router.post("/ecl/runs/:runId/finalize", requirePermission("compliance.ifrs9.manage"), async (req, res, next) => {
  try {
    const out = await svc.finalizeRun({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      runId: req.params.runId,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.post("/ecl/post", requirePermission("compliance.ifrs9.post"), async (req, res, next) => {
  try {
    const payload = validate(v.postEclSchema, req.body);
    const out = await svc.postEcl({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.post("/ecl/reverse", requirePermission("compliance.ifrs9.post"), async (req, res, next) => {
  try {
    const payload = validate(v.reverseEclSchema, req.body);
    const out = await svc.reverseEclPosting({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.get("/reports/allowance-movement", requirePermission("compliance.ifrs9.read"), async (req, res, next) => {
  try {
    const out = await svc.getAllowanceMovementReport({ orgId: req.user.organization_id, periodId: req.query.period_id });
    res.json(out);
  } catch (e) { next(e); }
});

router.get("/reports/disclosures", requirePermission("compliance.ifrs9.read"), async (req, res, next) => {
  try {
    const out = await svc.getDisclosuresReport({ orgId: req.user.organization_id, runId: req.query.run_id });
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
