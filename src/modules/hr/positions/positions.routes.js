const router = require("express").Router();

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

const { createPositionSchema, updatePositionSchema } = require("../../../shared/validators/hr.validators");
const svc = require("./positions.service");

router.use(authRequired);

router.post("/", idempotency({ required: true }), requirePermission("hr.positions.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createPositionSchema, req.body);
    res.status(201).json(await svc.createPosition({ orgId, actorUserId, payload, audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

router.get("/", requirePermission("hr.positions.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listPositions({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("hr.positions.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getPosition({ orgId, positionId: req.params.id }));
  } catch (e) { next(e); }
});

router.put("/:id", requirePermission("hr.positions.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(updatePositionSchema, req.body);
    res.json(await svc.updatePosition({ orgId, actorUserId, positionId: req.params.id, payload, audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

router.delete("/:id", requirePermission("hr.positions.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.deactivatePosition({ orgId, actorUserId, positionId: req.params.id, audit: req.audit, writeAudit }));
  } catch (e) { next(e); }
});

module.exports = router;
