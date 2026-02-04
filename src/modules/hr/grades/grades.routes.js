const router = require("express").Router();

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

const { createGradeSchema, updateGradeSchema } = require("../../../shared/validators/hr.validators");
const svc = require("./grades.service");

router.use(authRequired);

router.post("/", idempotency({ required: true }), requirePermission("hr.grades.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createGradeSchema, req.body);
    res.status(201).json(await svc.createGrade({ orgId, actorUserId, payload, audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

router.get("/", requirePermission("hr.grades.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listGrades({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("hr.grades.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getGrade({ orgId, gradeId: req.params.id }));
  } catch (e) { next(e); }
});

router.put("/:id", requirePermission("hr.grades.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(updateGradeSchema, req.body);
    res.json(await svc.updateGrade({ orgId, actorUserId, gradeId: req.params.id, payload, audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

router.delete("/:id", requirePermission("hr.grades.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.deactivateGrade({ orgId, actorUserId, gradeId: req.params.id, audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

module.exports = router;
