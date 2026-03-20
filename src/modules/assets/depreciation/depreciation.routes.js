const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { validate } = require("../../../shared/validators/validate");
const {
  createDepreciationScheduleSchema,
  updateDepreciationScheduleSchema,
  runDepreciationSchema,
} = require("../../../shared/validators/assets.validators");
const svc = require("./depreciation.service");

router.use(authRequired);

// Schedules
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

router.get("/schedules/:id", requirePermission("assets.fixed_assets.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getSchedule({ orgId, scheduleId: req.params.id }));
  } catch (e) { next(e); }
});

router.put("/schedules/:id", requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(updateDepreciationScheduleSchema, req.body);
    res.json(await svc.updateSchedule({ orgId, actorUserId, scheduleId: req.params.id, payload }));
  } catch (e) { next(e); }
});

router.delete("/schedules/:id", requirePermission("assets.fixed_assets.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    res.json(await svc.deleteSchedule({ orgId, actorUserId, scheduleId: req.params.id }));
  } catch (e) { next(e); }
});

// Preview + run + reverse
router.get("/preview", requirePermission("assets.depreciation.run"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { periodId } = req.query;
    if (!periodId) throw new AppError(400, "Please select an accounting period and try again.", { field: "periodId" }, "missing_period_id");
    res.json(await svc.previewPeriodEndDepreciation({ orgId, periodId }));
  } catch (e) { next(e); }
});

router.post("/run/period-end", idempotency({ required: true }), requirePermission("assets.depreciation.run"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const body = validate(runDepreciationSchema, req.body || {});
    res.json(await svc.runPeriodEndDepreciation({ orgId, actorUserId, periodId: body.periodId, entryDate: body.entryDate, memo: body.memo }));
  } catch (e) { next(e); }
});

router.post("/reverse/period-end", idempotency({ required: true }), requirePermission("assets.depreciation.run"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const body = validate(runDepreciationSchema, req.body || {});
    res.json(await svc.reversePeriodEndDepreciation({ orgId, actorUserId, periodId: body.periodId, entryDate: body.entryDate, memo: body.memo }));
  } catch (e) { next(e); }
});

module.exports = router;
