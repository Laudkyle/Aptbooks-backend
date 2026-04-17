const express = require("express");
const { requirePermission } = require("../../../middleware/permission.middleware");
const reconcile = require("../../../interfaces/reconciliation.interface");
const { authRequired } = require("../../../middleware/auth.middleware");
const router = express.Router();
router.use(authRequired);

router.get("/period", requirePermission("accounting.reconcile.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { periodId, onlyMismatches, persistHistory } = req.query;
    const data = await reconcile.reconcilePeriod({
      orgId,
      actorUserId,
      periodId,
      onlyMismatches: [true, "true", 1, "1"].includes(onlyMismatches),
      persistHistory: persistHistory !== "false",
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/discrepancy-details", requirePermission("accounting.reconcile.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, accountId } = req.query;
    const data = await reconcile.getDiscrepancyDetails({ orgId, periodId, accountId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/auto-correct", requirePermission("accounting.reconcile.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { periodId, threshold, dryRun } = req.body || {};
    const data = await reconcile.autoCorrect({
      orgId,
      actorUserId,
      periodId,
      threshold,
      dryRun: dryRun !== false,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent },
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/rebuild-balances", requirePermission("accounting.reconcile.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { periodId, dryRun } = req.body || {};
    const data = await reconcile.rebuildBalances({
      orgId,
      actorUserId,
      periodId,
      dryRun: dryRun !== false,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent },
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/history", requirePermission("accounting.reconcile.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, limit } = req.query;
    const data = await reconcile.getHistory({ orgId, periodId, limit });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/policy", requirePermission("accounting.reconcile.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const data = await reconcile.getPolicy({ orgId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.put("/policy", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const data = await reconcile.upsertPolicy({
      orgId,
      actorUserId,
      body: req.body || {},
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent },
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/export", requirePermission("accounting.reconcile.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { periodId, onlyMismatches, format } = req.query;
    const out = await reconcile.exportReconciliation({
      orgId,
      actorUserId,
      periodId,
      format,
      onlyMismatches: [true, "true", 1, "1"].includes(onlyMismatches),
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent },
    });
    res.setHeader("Content-Type", out.contentType);
    res.setHeader("Content-Disposition", out.contentDisposition);
    res.send(out.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
