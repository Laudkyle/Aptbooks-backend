const router = require("express").Router();

const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");

const svc = require("./reports.service");

router.use(authRequired);

router.get(
  "/headcount",
  requirePermission("hr.reports.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.headcount({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e); }
  }
);

router.get(
  "/leave-balances",
  requirePermission("hr.reports.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.leaveBalances({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e); }
  }
);

router.get(
  "/payroll-costs",
  requirePermission("hr.reports.read"),
  async (req, res, next) => {
    try {
      res.json(await svc.payrollCosts({ orgId: req.user.organization_id, query: req.query }));
    } catch (e) { next(e); }
  }
);

module.exports = router;
