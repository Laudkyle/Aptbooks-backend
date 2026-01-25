const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./banking.service");

const router = express.Router();

router.use(requirePermission("reporting.banking.read"));

router.get("/statement-status", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { from, to, bankAccountId } = req.query;
    const data = await svc.statementStatus({ orgId, fromDate: from, toDate: to, bankAccountId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
