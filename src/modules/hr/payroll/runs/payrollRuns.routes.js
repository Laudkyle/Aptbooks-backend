const router = require("express").Router();

const { authRequired } = require("../../../../middleware/auth.middleware");
const { requirePermission } = require("../../../../middleware/permission.middleware");
const { idempotency } = require("../../../../middleware/idempotency.middleware");
const { validate } = require("../../../../shared/validators/validate");

const { createPayrollRunSchema, updatePayrollRunSchema } = require("../../../../shared/validators/hr.payroll.validators");

const svc = require("./payrollRuns.service");

router.use(authRequired);

router.post(
  "/",
  idempotency({ required: true }),
  requirePermission("hr.payroll.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const payload = validate(createPayrollRunSchema, req.body);
      res.status(201).json(await svc.createRun({ orgId, actorUserId, payload }));
    } catch (e) {
      next(e);
    }
  }
);

router.get("/", requirePermission("hr.payroll.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listRuns({ orgId, query: req.query }));
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requirePermission("hr.payroll.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getRun({ orgId, runId: req.params.id }));
  } catch (e) {
    next(e);
  }
});


router.put(
  "/:id",
  requirePermission("hr.payroll.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const payload = validate(updatePayrollRunSchema, req.body);
      res.json(await svc.updateRun({ orgId, actorUserId, runId: req.params.id, payload }));
    } catch (e) {
      next(e);
    }
  }
);

router.patch(
  "/:id",
  requirePermission("hr.payroll.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const payload = validate(updatePayrollRunSchema, req.body);
      res.json(await svc.updateRun({ orgId, actorUserId, runId: req.params.id, payload }));
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  "/:id",
  requirePermission("hr.payroll.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      res.json(await svc.deleteRun({ orgId, actorUserId, runId: req.params.id }));
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  "/:id/calculate",
  idempotency({ required: true }),
  requirePermission("hr.payroll.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      res.json(await svc.calculateRun({ orgId, actorUserId, runId: req.params.id }));
    } catch (e) {
      next(e);
    }
  }
);


router.post(
  "/:id/submit-for-approval",
  idempotency({ required: true }),
  requirePermission("hr.payroll.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      res.json(await svc.submitRunForApproval({ orgId, actorUserId, runId: req.params.id }));
    } catch (e) { next(e); }
  }
);

router.post(
  "/:id/approve",
  idempotency({ required: true }),
  requirePermission("hr.payroll.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      res.json(await svc.approveRunWorkflow({ orgId, actorUserId, runId: req.params.id, comment: req.body?.comment || null }));
    } catch (e) { next(e); }
  }
);

router.post(
  "/:id/reject",
  idempotency({ required: true }),
  requirePermission("hr.payroll.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      res.json(await svc.rejectRunWorkflow({ orgId, actorUserId, runId: req.params.id, comment: req.body?.comment || null }));
    } catch (e) { next(e); }
  }
);

// Build a DRAFT journal for the run (Segregation-of-duties: creator cannot post)
router.post(
  "/:id/journal",
  idempotency({ required: true }),
  requirePermission("hr.payroll.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const idempotencyKey = req.header("Idempotency-Key") || req.header("idempotency-key");
      res.json(await svc.buildJournal({ orgId, actorUserId, runId: req.params.id, idempotencyKey }));
    } catch (e) {
      next(e);
    }
  }
);

// Post the previously-built draft journal
router.post(
  "/:id/journal/post",
  idempotency({ required: true }),
  requirePermission("hr.payroll.post"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      res.json(await svc.postJournal({ orgId, actorUserId, runId: req.params.id }));
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/:id/lines",
  requirePermission("hr.payroll.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      res.json(await svc.listRunLines({ orgId, runId: req.params.id }));
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
