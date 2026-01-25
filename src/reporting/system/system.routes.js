const express = require("express"); 

const { authRequired } = require("../../middleware/auth.middleware"); 
const { requirePermission } = require("../../middleware/permission.middleware"); 
const { schedulerHealthSummary } = require("../../health/health.routes"); 

/**
 * Tier 6: Reporting - System observability
 *
 * Read-only operational endpoints for modern accounting operations:
 * - Scheduler task health (run status, failure counts, durations)
 */

const router = express.Router(); 

router.use(authRequired); 

// Expose scheduler job health KPIs as part of Reporting (Tier 6)
router.get(
  "/jobs-health",
  requirePermission("reporting.audit.read"),
  async (req, res, next) => {
    try {
      const windowDays = req.query.windowDays ?? 7; 
      const limit = req.query.limit ?? 200; 
      const data = await schedulerHealthSummary({ windowDays, limit }); 
      res.json({ ok: true, data }); 
    } catch (e) {
      next(e); 
    }
  }
); 

module.exports = router; 
