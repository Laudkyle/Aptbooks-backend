const express = require("express");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const service = require("./dimensionSecurity.service");

const router = express.Router();
router.use(authRequired);

router.get("/rules", requirePermission("core.dimension_security.read"), async (req, res, next) => {
  try {
    const ctx = {
      organizationId: req.user.organization_id,
      userId: req.user.id,
      ip: req.ip,
      userAgent: req.get("user-agent") || null,
    };
    const { limit = "100", offset = "0" } = req.query;
    const rules = await service.listRules(ctx, { limit: Number(limit), offset: Number(offset) });
    res.json({ data: rules });
  } catch (e) { next(e); }
});

router.post("/rules", requirePermission("core.dimension_security.manage"), async (req, res, next) => {
  try {
    const ctx = {
      organizationId: req.user.organization_id,
      userId: req.user.id,
      ip: req.ip,
      userAgent: req.get("user-agent") || null,
    };
    const created = await service.createRule(ctx, req.body || {});
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.put("/rules/:ruleId", requirePermission("core.dimension_security.manage"), async (req, res, next) => {
  try {
    const ctx = {
      organizationId: req.user.organization_id,
      userId: req.user.id,
      ip: req.ip,
      userAgent: req.get("user-agent") || null,
    };
    const updated = await service.updateRule(ctx, req.params.ruleId, req.body || {});
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.delete("/rules/:ruleId", requirePermission("core.dimension_security.manage"), async (req, res, next) => {
  try {
    const ctx = {
      organizationId: req.user.organization_id,
      userId: req.user.id,
      ip: req.ip,
      userAgent: req.get("user-agent") || null,
    };
    const out = await service.deleteRule(ctx, req.params.ruleId);
    res.json({ data: out });
  } catch (e) { next(e); }
});

module.exports = router;
