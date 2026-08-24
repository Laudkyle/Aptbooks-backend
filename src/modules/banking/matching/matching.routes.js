const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const express = require("express");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const svc = require("./matching.service");

const router = express.Router();
router.use(createModuleBodyContract(['amount_tolerance', 'date_window_days', 'description_similarity_min', 'is_active', 'name', 'priority']));
router.use(authRequired);

// Matching rules CRUD
router.get("/rules", requirePermission("banking.matching.rules.manage"), async (req, res, next) => {
  try {
    res.json(await svc.listRules(req.user.organization_id));
  } catch (e) { next(e); }
});

router.post("/rules", idempotency({ required: true }), requirePermission("banking.matching.rules.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: userId } = req.user;
    res.status(201).json(await svc.createRule(orgId, userId, req.body));
  } catch (e) { next(e); }
});

router.put("/rules/:id", idempotency({ required: true }), requirePermission("banking.matching.rules.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json(await svc.updateRule(orgId, req.params.id, req.body));
  } catch (e) { next(e); }
});

// Suggest matches for a statement line
router.get("/lines/:lineId/suggestions", requirePermission("banking.matching.suggest"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json(await svc.suggestMatches(orgId, req.params.lineId, req.query));
  } catch (e) { next(e); }
});

module.exports = router;
