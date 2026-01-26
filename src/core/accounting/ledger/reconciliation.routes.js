const express = require("express");
const { requirePermission } = require("../../../middleware/permission.middleware");
const reconcile = require("../../../interfaces/reconciliation.interface");
const { authRequired } = require("../../../middleware/auth.middleware");

const router = express.Router();

// Apply authentication to all routes
router.use(authRequired);

/**
 * GET /period
 * Run reconciliation for a specific period
 * Query params:
 *   - periodId (required): Period ID to reconcile
 *   - onlyMismatches (optional): Return only accounts with discrepancies (true/false)
 */
router.get("/period", requirePermission("accounting.reconcile.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId, user_id: actorUserId } = req.user;
    const { periodId, onlyMismatches } = req.query;
    
    const data = await reconcile.reconcilePeriod({ 
      orgId, 
      periodId,
      onlyMismatches: onlyMismatches === 'true',
      actorUserId,
      req,
    });
    
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /discrepancy-details
 * Get detailed transaction breakdown for a specific account discrepancy
 * Query params:
 *   - periodId (required): Period ID
 *   - accountId (required): Account ID to investigate
 */
router.get(
  "/discrepancy-details", 
  requirePermission("accounting.reconcile.view_details"), 
  async (req, res, next) => {
    try {
      const { organization_id: orgId, user_id: actorUserId } = req.user;
      const { periodId, accountId } = req.query;
      
      const data = await reconcile.getDiscrepancyDetails({ 
        orgId, 
        periodId, 
        accountId,
        actorUserId,
        req,
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /auto-correct
 * Auto-correct minor rounding differences in GL balances
 * Body params:
 *   - periodId (required): Period ID to correct
 *   - threshold (optional): Maximum variance to auto-correct (default: 0.01)
 *   - dryRun (optional): Preview changes without applying (default: true)
 */
router.post(
  "/auto-correct", 
  requirePermission("accounting.reconcile.auto_correct"), 
  async (req, res, next) => {
    try {
      const { organization_id: orgId, user_id: actorUserId } = req.user;
      const { periodId, threshold, dryRun } = req.body;
      
      const data = await reconcile.autoCorrectRoundingDifferences({ 
        orgId, 
        periodId,
        threshold: threshold ? Number(threshold) : 0.01,
        dryRun: dryRun !== false, // Default to true for safety
        actorUserId,
        req,
      });
      
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;