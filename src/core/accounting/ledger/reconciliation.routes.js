const { createModuleBodyContract, z, validateBody } = require("../../../shared/http/requestValidation");
const express = require("express");
const { requirePermission } = require("../../../middleware/permission.middleware");
const reconcile = require("../../../interfaces/reconciliation.interface");
const { authRequired } = require("../../../middleware/auth.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const router = express.Router();
router.use(createModuleBodyContract(['defaultThreshold', 'diffs', 'dryRun', 'exactMatchTolerance', 'periodId', 'policy', 'summary', 'threshold', 'thresholdsByAccountType']));
router.use(authRequired);
const nonnegativeNumber = z.union([z.number().finite().nonnegative(), z.string().trim().regex(/^\d+(?:\.\d+)?$/)]);
const autoCorrectSchema = z.object({ periodId: z.string().uuid(), threshold: nonnegativeNumber.optional(), dryRun: z.boolean().optional() }).strict();
const rebuildSchema = z.object({ periodId: z.string().uuid(), dryRun: z.boolean().optional() }).strict();
const policySchema = z.object({
  defaultThreshold: nonnegativeNumber.optional(),
  exactMatchTolerance: nonnegativeNumber.optional(),
  thresholdsByAccountType: z.record(z.string(), nonnegativeNumber).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No policy fields provided");
const requireMutationIdempotency = idempotency({ required: true });
router.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  return requireMutationIdempotency(req, res, next);
});

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

router.post("/auto-correct", requirePermission("accounting.reconcile.run"), validateBody(autoCorrectSchema), async (req, res, next) => {
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

router.post("/rebuild-balances", requirePermission("accounting.reconcile.run"), validateBody(rebuildSchema), async (req, res, next) => {
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

router.put("/policy", requirePermission("settings.manage"), validateBody(policySchema), async (req, res, next) => {
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
