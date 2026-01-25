const express = require("express"); 
const { requirePermission } = require("../../middleware/permission.middleware"); 
const svc = require("./managementReports.service"); 

const router = express.Router(); 

function orgId(req) { return req.user.organization_id;  }

router.get(
  "/departmental-pnl",
  requirePermission("reporting.management.read"),
  async (req, res, next) => {
    try {
      const { periodId, costCenterId, profitCenterId, projectId } = req.query; 
      if (!periodId) return res.status(400).json({ error: "periodId is required" }); 
      const data = await svc.departmentalPnL({
        organizationId: orgId(req),
        periodId,
        costCenterId: costCenterId || null,
        profitCenterId: profitCenterId || null,
        projectId: projectId || null,
      }); 
      res.json({ data }); 
    } catch (e) { next(e);  }
  }
); 

router.get(
  "/cost-center-summary",
  requirePermission("reporting.management.read"),
  async (req, res, next) => {
    try {
      const { periodId } = req.query; 
      if (!periodId) return res.status(400).json({ error: "periodId is required" }); 
      const data = await svc.costCenterSummary({ organizationId: orgId(req), periodId }); 
      res.json({ data }); 
    } catch (e) { next(e);  }
  }
); 

module.exports = router; 
