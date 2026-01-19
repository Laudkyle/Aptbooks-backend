const express = require("express");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const service = require("./connections.service");

const router = express.Router();
router.use(authRequired);

router.get("/", requirePermission("integrations.connections.read"), async (req, res, next) => {
  try {
    const ctx = { organizationId: req.user.organization_id, userId: req.user.id, ip: req.ip, userAgent: req.get("user-agent") || null };
    const data = await service.list(ctx);
    res.json({ data });
  } catch (e) { next(e); }
});

router.post("/", requirePermission("integrations.connections.manage"), async (req, res, next) => {
  try {
    const ctx = { organizationId: req.user.organization_id, userId: req.user.id, ip: req.ip, userAgent: req.get("user-agent") || null };
    const created = await service.create(ctx, req.body || {});
    res.status(201).json({ data: created });
  } catch (e) { next(e); }
});

router.put("/:id", requirePermission("integrations.connections.manage"), async (req, res, next) => {
  try {
    const ctx = { organizationId: req.user.organization_id, userId: req.user.id, ip: req.ip, userAgent: req.get("user-agent") || null };
    const updated = await service.update(ctx, req.params.id, req.body || {});
    res.json({ data: updated });
  } catch (e) { next(e); }
});

router.post("/:id/test", requirePermission("integrations.connections.manage"), async (req, res, next) => {
  try {
    const ctx = { organizationId: req.user.organization_id, userId: req.user.id, ip: req.ip, userAgent: req.get("user-agent") || null };
    const out = await service.test(ctx, req.params.id);
    res.json({ data: out });
  } catch (e) { next(e); }
});

router.delete("/:id", requirePermission("integrations.connections.manage"), async (req, res, next) => {
  try {
    const ctx = { organizationId: req.user.organization_id, userId: req.user.id, ip: req.ip, userAgent: req.get("user-agent") || null };
    const out = await service.remove(ctx, req.params.id);
    res.json({ data: out });
  } catch (e) { next(e); }
});

module.exports = router;
