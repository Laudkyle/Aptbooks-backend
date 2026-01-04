const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./financialStatements.service");

const router = express.Router();

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
    const { periodId } = req.query;
    const data = await svc.incomeStatement({ orgId, periodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/balance-sheet", async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId } = req.query;
    const data = await svc.balanceSheet({ orgId, periodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/generate", async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { periodId, statementType } = req.body;
    const created = await svc.generateAndPersist({ orgId, periodId, statementType, actorUserId, req });
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
