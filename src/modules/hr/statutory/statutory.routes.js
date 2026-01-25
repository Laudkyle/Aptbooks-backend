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
    } catch (e) { next(e);}
  }
);

router.get(
  "/rules",
  requirePermission("hr.statutory.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.listRules({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e);}
  }
);

// Bulk export (CSV)
router.get("/rules/export", requirePermission("hr.statutory.export"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const csv = await svc.exportStatutoryRulesCsv({ orgId, query: req.query });
    res.setHeader("Content-Type", "text/csv;charset=utf-8");
    res.setHeader("Content-Disposition", "attachment;filename=statutory_rules.csv");
    res.status(200).send(csv);
  } catch (e) { next(e);}
});

// Bulk import (JSON array)
router.post(
  "/rules/import",
  idempotency({ required: true }),
  requirePermission("hr.statutory.import"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const { rules, mode } = req.body || {};
      res.status(200).json(await svc.importRules({ orgId, actorUserId, rules, mode, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

// Bulk import (CSV body)
router.post(
  "/rules/import/csv",
  idempotency({ required: true }),
  requirePermission("hr.statutory.import_csv"),
  require("express").text({ type: ["text/csv","application/csv","application/vnd.ms-excel"], limit: "5mb" }),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const actorUserId = req.user.id;
      const csvText = req.body;
      const { mode } = req.query || {};
      res.status(200).json(await svc.importRulesCsv({ orgId, actorUserId, csvText, mode, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

router.put(
  "/rules/:id",
  requirePermission("hr.statutory.manage"),
  async (req, res, next) => {
    try {
      const payload = validate(updateStatutoryRuleSchema, req.body);
      res.json(await svc.updateRule({ orgId: req.user.organization_id, actorUserId: req.user.id, ruleId: req.params.id, payload, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

router.delete(
  "/rules/:id",
  requirePermission("hr.statutory.manage"),
  async (req, res, next) => {
    try {
      res.json(await svc.deactivateRule({ orgId: req.user.organization_id, actorUserId: req.user.id, ruleId: req.params.id, audit: req.audit, writeAudit }));
    } catch (e) { next(e);}
  }
);

module.exports = router;
