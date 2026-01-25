const express = require("express");
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./clientLogs.service");

const router = express.Router();
router.use(authRequired);

router.post(
  "/",
  idempotency({ required: true }),
  requirePermission("utilities.client_logs.write"),
  express.json({ limit: "256kb" }),
  async (req, res, next) => {
    try {
      const { organization_id: orgId, id: userId } = req.user;
      res.status(201).json(await svc.ingest(orgId, userId, req));
    } catch (e) { next(e);}
  }
);

router.get(
  "/",
  requirePermission("utilities.client_logs.read"),
  async (req, res, next) => {
    try {
      const { organization_id: orgId } = req.user;
      res.json(await svc.query(orgId, req.query));
    } catch (e) { next(e);}
  }
);

module.exports = router;
