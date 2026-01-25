const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./financialStatements.service");
const { authRequired } = require("../../middleware/auth.middleware");

const router = express.Router();
router.use(authRequired)
router.use(requirePermission("reporting.statements.read"));

router.get("/trial-balance", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId } = req.query;
    const data = await svc.trialBalance({ orgId, periodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/income-statement", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, comparePeriodId, mode } = req.query;
    const data = await svc.incomeStatement({ orgId, periodId, comparePeriodId, mode });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/balance-sheet", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, comparePeriodId } = req.query;
    const data = await svc.balanceSheet({ orgId, periodId, comparePeriodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/cash-flow", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, comparePeriodId } = req.query;
    const data = await svc.cashFlowStatement({ orgId, periodId, comparePeriodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/changes-in-equity", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, comparePeriodId } = req.query;
    const data = await svc.changesInEquityStatement({ orgId, periodId, comparePeriodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/generate", idempotency({ required: true }), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { periodId, statementType, comparePeriodId, mode } = req.body;
    const created = await svc.generateAndPersist({ orgId, periodId, statementType, comparePeriodId, mode, actorUserId, req });
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

router.get("/generated", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, statementType, limit } = req.query;
    const data = await svc.listGenerated({ orgId, periodId, statementType, limit });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
