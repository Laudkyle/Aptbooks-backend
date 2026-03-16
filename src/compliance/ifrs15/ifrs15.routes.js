const express = require("express");
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const { validate } = require("../../shared/validators/validate");

const svc = require("./ifrs15.service");
const v = require("./ifrs15.validators");

const router = express.Router();

router.use(authRequired);

// Settings
router.get(
  "/settings",
  requirePermission("compliance.ifrs15.read"),
  async (req, res, next) => {
    try {
      const data = await svc.getSettings({ orgId: req.user.organization_id });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.put(
  "/settings",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.upsertSettings, req.body);
      const data = await svc.upsertSettings({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

// Contracts
router.post(
  "/contracts/:contractId/submit-for-approval",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const data = await svc.submitContractForApproval({ orgId: req.user.organization_id, actorUserId: req.user.id, contractId: params.contractId });
      res.json(data);
    } catch (e) { next(e); }
  }
);

router.post(
  "/contracts/:contractId/approve",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const data = await svc.approveContractWorkflow({ orgId: req.user.organization_id, actorUserId: req.user.id, contractId: params.contractId, comment: req.body?.comment || null });
      res.json(data);
    } catch (e) { next(e); }
  }
);

router.post(
  "/contracts/:contractId/reject",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const data = await svc.rejectContractWorkflow({ orgId: req.user.organization_id, actorUserId: req.user.id, contractId: params.contractId, comment: req.body?.comment || null });
      res.json(data);
    } catch (e) { next(e); }
  }
);

router.get(
  "/contracts",
  requirePermission("compliance.ifrs15.read"),
  async (req, res, next) => {
    try {
      const data = await svc.listContracts({ orgId: req.user.organization_id, query: req.query });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(v.createContract, req.body);
      const data = await svc.createContract({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        payload,
      });
      res.status(201).json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/contracts/:contractId",
  requirePermission("compliance.ifrs15.read"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const data = await svc.getContract({ orgId: req.user.organization_id, contractId: params.contractId });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/obligations",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const payload = validate(v.addObligation, { ...req.body, ...params });
      const data = await svc.addObligation({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        payload,
      });
      res.status(201).json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/activate",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const payload = validate(v.activateContract, { ...req.body, ...params });
      const data = await svc.activateContract({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/schedule/generate",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const payload = validate(v.generateSchedule, { ...req.body, ...params });
      const data = await svc.generateSchedule({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/contracts/:contractId/schedule",
  requirePermission("compliance.ifrs15.read"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const data = await svc.getSchedule({ orgId: req.user.organization_id, contractId: params.contractId });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/post",
  requirePermission("compliance.ifrs15.post"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const body = validate(v.postRevenue, req.body);
      const data = await svc.postRevenueForPeriod({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        payload: body,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

// --------------------
// Stage 2 extensions
// --------------------

router.post(
  "/contracts/:contractId/modifications",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const payload = validate(v.createModification, { ...req.body, ...params });
      const data = await svc.createModification({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        payload,
      });
      res.status(201).json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/modifications/:modificationId/apply",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.modificationIdParam, req.params);
      const payload = validate(v.applyModification, req.body);
      const data = await svc.applyModification({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        modificationId: params.modificationId,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/variable-consideration",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const payload = validate(v.createVariableConsideration, { ...req.body, ...params });
      const data = await svc.createVariableConsideration({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        payload,
      });
      res.status(201).json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/variable-consideration/:variableConsiderationId/review",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.variableConsiderationIdParam, req.params);
      const payload = validate(v.reviewVariableConsideration, req.body);
      const data = await svc.reviewVariableConsideration({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        variableConsiderationId: params.variableConsiderationId,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/variable-consideration/:variableConsiderationId/approve",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.variableConsiderationIdParam, req.params);
      const payload = validate(v.approveVariableConsideration, req.body);
      const data = await svc.approveVariableConsideration({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        variableConsiderationId: params.variableConsiderationId,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/variable-consideration/apply",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const payload = validate(v.applyVariableConsideration, req.body);
      const data = await svc.applyVariableConsideration({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);
router.put(
  "/contracts/:contractId/financing-terms",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const payload = validate(v.setFinancingTerms, { ...req.body, ...params });
      const data = await svc.setFinancingTerms({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/financing/post",
  requirePermission("compliance.ifrs15.post"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const payload = validate(v.postFinancing, req.body);
      const data = await svc.postFinancingForPeriod({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/costs",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const payload = validate(v.createCost, { ...req.body, ...params });
      const data = await svc.createCost({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        payload,
      });
      res.status(201).json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/contracts/:contractId/costs",
  requirePermission("compliance.ifrs15.read"),
  async (req, res, next) => {
    try {
      const params = validate(v.contractIdParam, req.params);
      const data = await svc.listCosts({ orgId: req.user.organization_id, contractId: params.contractId });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/costs/:costId/schedule/generate",
  requirePermission("compliance.ifrs15.manage"),
  async (req, res, next) => {
    try {
      const params = validate(v.costIdParam, req.params);
      const payload = validate(v.generateCostSchedule, { ...req.body, ...params });
      const data = await svc.generateCostSchedule({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        costId: params.costId,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/contracts/:contractId/costs/:costId/post",
  requirePermission("compliance.ifrs15.post"),
  async (req, res, next) => {
    try {
      const params = validate(v.costIdParam, req.params);
      const payload = validate(v.postCostAmort, req.body);
      const data = await svc.postCostAmortForPeriod({
        orgId: req.user.organization_id,
        actorUserId: req.user.id,
        contractId: params.contractId,
        costId: params.costId,
        payload,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/reports/contract-rollforward",
  requirePermission("compliance.ifrs15.read"),
  async (req, res, next) => {
    try {
      const q = validate(v.rollforwardReport, req.query);
      const data = await svc.contractRollforwardReport({ orgId: req.user.organization_id, periodId: q.period_id });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/reports/remaining-performance-obligations",
  requirePermission("compliance.ifrs15.read"),
  async (req, res, next) => {
    try {
      const q = validate(v.rpoReport, req.query);
      const data = await svc.remainingPerformanceObligationsReport({
        orgId: req.user.organization_id,
        asOfPeriodId: q.as_of_period_id,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/reports/revenue-disaggregation",
  requirePermission("compliance.ifrs15.read"),
  async (req, res, next) => {
    try {
      const q = validate(v.revenueDisaggregationReport, req.query);
      const data = await svc.revenueDisaggregationReport({
        orgId: req.user.organization_id,
        periodId: q.period_id,
        dimension: q.dimension,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/reports/judgements",
  requirePermission("compliance.ifrs15.read"),
  async (req, res, next) => {
    try {
      const q = validate(v.judgementsReport, req.query);
      const data = await svc.judgementsReport({
        orgId: req.user.organization_id,
        asOfDate: q.as_of_date,
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
