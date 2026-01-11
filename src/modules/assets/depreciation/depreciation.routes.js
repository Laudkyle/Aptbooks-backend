const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const { createDepreciationScheduleSchema, runDepreciationSchema } = require("../../../shared/validators/assets.validators");
const svc = require("./depreciation.service");

router.use(authRequired);

router.post("/schedules", idempotency({ required: true }), requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createDepreciationScheduleSchema, req.body);
    res.status(201).json(await svc.createSchedule({ orgId, actorUserId, payload }));
  } catch (e) { next(e); }
});

router.get("/schedules", requirePermission("assets.fixed_assets.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listSchedules({ orgId, query: req.query }));
  } catch (e) { next(e); }
});

router.post("/run/period-end", idempotency({ required: true }), requirePermission("assets.depreciation.run"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const body = validate(runDepreciationSchema, req.body || {});
    res.json(await svc.runPeriodEndDepreciation({ orgId, actorUserId, periodId: body.periodId }));
  } catch (e) { next(e); }
});

module.exports = router;
