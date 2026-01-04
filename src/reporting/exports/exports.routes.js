const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./exports.service");

const router = express.Router();

router.get("/trial-balance", requirePermission("reporting.exports.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, format = "json" } = req.query;
    const out = await svc.exportTrialBalance({ orgId, periodId, format });
    if (out.contentType) res.setHeader("Content-Type", out.contentType);
    res.send(out.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
