const express = require("express");
const { requirePermission } = require("../../../middleware/permission.middleware");
const reports = require("../../../interfaces/reportGeneration.interface");
const { authRequired } = require("../../../middleware/auth.middleware");
const { resolveOrgId } = require("../../../reporting/_util");

const router = express.Router();
router.use(authRequired)
router.get("/trial-balance", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { periodId } = req.query;
    const data = await reports.generateStatement({ orgId, periodId, statementType: "trial_balance" });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/income-statement", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { periodId, comparePeriodId, mode } = req.query;
    const data = await reports.generateStatement({ orgId, periodId, comparePeriodId, mode, statementType: "income_statement" });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/balance-sheet", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { periodId, comparePeriodId } = req.query;
    const data = await reports.generateStatement({ orgId, periodId, comparePeriodId, statementType: "balance_sheet" });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/cash-flow", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { periodId, comparePeriodId } = req.query;
    const data = await reports.generateStatement({ orgId, periodId, comparePeriodId, statementType: "cash_flow" });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/changes-in-equity", requirePermission("accounting.balances.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { periodId, comparePeriodId } = req.query;
    const data = await reports.generateStatement({ orgId, periodId, comparePeriodId, statementType: "changes_in_equity" });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
