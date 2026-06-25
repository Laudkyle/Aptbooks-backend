const router = require("express").Router();

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

const { createStatutoryRuleSchema, updateStatutoryRuleSchema } = require("../../../shared/validators/hr.validators");
const svc = require("./statutory.service");

router.use(authRequired);

router.post(
  "/rules",
  idempotency({ required: true }),
  requirePermission("hr.statutory.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(createStatutoryRuleSchema, req.body);
      res.status(201).json(await svc.createRule({ orgId: req.user.organization_id, actorUserId: req.user.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

router.get(
  "/rules",
  requirePermission("hr.statutory.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.listRules({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e); }
  }
);

router.get(
  "/rules/:id",
  requirePermission("hr.statutory.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.getRule({ orgId: req.user.organization_id, ruleId: req.params.id }));
    } catch (e) { next(e); }
  }
);

router.put(
  "/rules/:id",
  requirePermission("hr.statutory.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(updateStatutoryRuleSchema, req.body);
      res.json(await svc.updateRule({ orgId: req.user.organization_id, actorUserId: req.user.id, ruleId: req.params.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

router.delete(
  "/rules/:id",
  requirePermission("hr.statutory.manage"),
  async (req, res, next) => {
    try {
      res.json(await svc.deactivateRule({ orgId: req.user.organization_id, actorUserId: req.user.id, ruleId: req.params.id, audit: req.audit, writeAudit }));
    } catch (e) { next(e); }
  }
);

module.exports = router;
