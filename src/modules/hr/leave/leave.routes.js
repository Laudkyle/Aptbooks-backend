const router = require("express").Router();

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

const {
  createLeaveTypeSchema,
  updateLeaveTypeSchema,
  upsertLeaveBalanceSchema,
  createLeaveRequestSchema,
  rejectLeaveRequestSchema,
} = require("../../../shared/validators/hr.validators");

const svc = require("./leave.service");

router.use(authRequired);

// Leave Types
router.post(
  "/types",
  idempotency({ required: true }),
  requirePermission("hr.leave.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const payload = validate(createLeaveTypeSchema, req.body);
      res.status(201).json(await svc.createLeaveType({ orgId, actorUserId, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

router.get(
  "/types",
  requirePermission("hr.leave.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.listLeaveTypes({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e); }
  }
);

router.put(
  "/types/:id",
  requirePermission("hr.leave.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(updateLeaveTypeSchema, req.body);
      res.json(await svc.updateLeaveType({ orgId: req.user.organization_id, actorUserId: req.user.id, leaveTypeId: req.params.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

router.delete(
  "/types/:id",
  requirePermission("hr.leave.manage"),
  async (req, res, next) => {
    try {
      res.json(await svc.deactivateLeaveType({ orgId: req.user.organization_id, actorUserId: req.user.id, leaveTypeId: req.params.id, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

// Leave Balances
router.post(
  "/balances",
  idempotency({ required: true }),
  requirePermission("hr.leave.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(upsertLeaveBalanceSchema, req.body);
      res.status(201).json(await svc.upsertLeaveBalance({ orgId: req.user.organization_id, actorUserId: req.user.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

router.get(
  "/balances",
  requirePermission("hr.leave.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.listLeaveBalances({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e); }
  }
);

// Leave Requests
router.post(
  "/requests",
  idempotency({ required: true }),
  requirePermission("hr.leave.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(createLeaveRequestSchema, req.body);
      res.status(201).json(await svc.createLeaveRequest({ orgId: req.user.organization_id, actorUserId: req.user.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

router.get(
  "/requests",
  requirePermission("hr.leave.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.listLeaveRequests({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e); }
  }
);

router.get(
  "/requests/:id",
  requirePermission("hr.leave.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.getLeaveRequest({ orgId: req.user.organization_id, requestId: req.params.id }));
    } catch (e) { next(e); }
  }
);

router.post(
  "/requests/:id/submit",
  idempotency({ required: true }),
  requirePermission("hr.leave.manage"),
  async (req, res, next) => {
    try {
      res.json(await svc.submitLeaveRequest({ orgId: req.user.organization_id, actorUserId: req.user.id, requestId: req.params.id, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

router.post(
  "/requests/:id/approve",
  idempotency({ required: true }),
  requirePermission("hr.leave.manage"),
  async (req, res, next) => {
    try {
      res.json(await svc.approveLeaveRequest({ orgId: req.user.organization_id, actorUserId: req.user.id, requestId: req.params.id, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

router.post(
  "/requests/:id/reject",
  idempotency({ required: true }),
  requirePermission("hr.leave.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(rejectLeaveRequestSchema, req.body || {});
      res.json(await svc.rejectLeaveRequest({ orgId: req.user.organization_id, actorUserId: req.user.id, requestId: req.params.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

router.post(
  "/requests/:id/cancel",
  idempotency({ required: true }),
  requirePermission("hr.leave.manage"),
  async (req, res, next) => {
    try {
      res.json(await svc.cancelLeaveRequest({ orgId: req.user.organization_id, actorUserId: req.user.id, requestId: req.params.id, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

module.exports = router;
