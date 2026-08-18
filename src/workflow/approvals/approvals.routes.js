const router = require("express").Router();
const { authRequired } = require("../../middleware/auth.middleware");
const { requireAnyPermission } = require("../../middleware/permission.middleware");
const svc = require("./approvals.service");

router.use(authRequired);

router.get("/inbox", requireAnyPermission(["approvals.inbox.read", "approvals.act"]), async (req, res, next) => {
  try {
    res.json(await svc.inbox(req.user.organization_id, req.user.id, req.query));
  } catch (e) { next(e); }
});

module.exports = router;
