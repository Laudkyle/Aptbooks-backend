const router = require("express").Router();

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

const {
  createBenefitPlanSchema,
  updateBenefitPlanSchema,
  assignEmployeeBenefitSchema,
  updateEmployeeBenefitSchema,
} = require("../../../shared/validators/hr.validators");

const svc = require("./benefits.service");

router.use(authRequired);

// Benefit Plans
router.post(
  "/plans",
  idempotency({ required: true }),
  requirePermission("hr.benefits.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(createBenefitPlanSchema, req.body);
      res.status(201).json(await svc.createBenefitPlan({ orgId: req.user.organization_id, actorUserId: req.user.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

router.get(
  "/plans",
  requirePermission("hr.benefits.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.listBenefitPlans({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e);}
  }
);

// Bulk export (CSV)
router.get("/plans/export", requirePermission("hr.benefits.export"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const csv = await svc.exportBenefitPlansCsv({ orgId, query: req.query });
    res.setHeader("Content-Type", "text/csv;charset=utf-8");
    res.setHeader("Content-Disposition", "attachment;filename=benefit_plans.csv");
    res.status(200).send(csv);
  } catch (e) { next(e);}
});

// Bulk import (JSON array)
router.post("/plans/import", idempotency({ required: true }), requirePermission("hr.benefits.import"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const { plans, mode } = req.body || {};
    res.status(200).json(await svc.importBenefitPlans({ orgId, actorUserId, plans, mode, audit: req.audit, writeAudit }));
  } catch (e) { next(e);}
});

// Bulk import (CSV body)
router.post(
  "/plans/import/csv",
  idempotency({ required: true }),
  requirePermission("hr.benefits.import_csv"),
  require("express").text({ type: ["text/csv","application/csv","application/vnd.ms-excel"], limit: "5mb" }),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const csvText = req.body;
      const { mode } = req.query || {};
      res.status(200).json(await svc.importBenefitPlansCsv({ orgId, actorUserId, csvText, mode, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

router.put(
  "/plans/:id",
  requirePermission("hr.benefits.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(updateBenefitPlanSchema, req.body);
      res.json(await svc.updateBenefitPlan({ orgId: req.user.organization_id, actorUserId: req.user.id, planId: req.params.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

router.delete(
  "/plans/:id",
  requirePermission("hr.benefits.manage"),
  async (req, res, next) => {
    try {
      res.json(await svc.deactivateBenefitPlan({ orgId: req.user.organization_id, actorUserId: req.user.id, planId: req.params.id, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

// Employee Benefits
router.post(
  "/employee-benefits",
  idempotency({ required: true }),
  requirePermission("hr.benefits.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(assignEmployeeBenefitSchema, req.body);
      res.status(201).json(await svc.assignEmployeeBenefit({ orgId: req.user.organization_id, actorUserId: req.user.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

router.get(
  "/employee-benefits",
  requirePermission("hr.benefits.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.listEmployeeBenefits({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e);}
  }
);

router.put(
  "/employee-benefits/:id",
  requirePermission("hr.benefits.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(updateEmployeeBenefitSchema, req.body);
      res.json(await svc.updateEmployeeBenefit({ orgId: req.user.organization_id, actorUserId: req.user.id, employeeBenefitId: req.params.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

router.delete(
  "/employee-benefits/:id",
  requirePermission("hr.benefits.manage"),
  async (req, res, next) => {
    try {
      res.json(await svc.deactivateEmployeeBenefit({ orgId: req.user.organization_id, actorUserId: req.user.id, employeeBenefitId: req.params.id, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

module.exports = router;
