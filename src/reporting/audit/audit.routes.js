const router = require("express").Router();
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./audit.service");

router.use(requirePermission("reporting.audit.read"));

// User activity + audit log stream
router.get("/activity", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.listActivity({ orgId, query: req.query });
    res.json({ data: out });
  } catch (e) { next(e); }
});

// Reporting definition changes (triggered audit table from Stage 5)
router.get("/definition-changes", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.listDefinitionChanges({ orgId, query: req.query });
    res.json({ data: out });
  } catch (e) { next(e); }
});

// Period close audit pack summary
router.get("/period-close", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { periodId } = req.query;
    const out = await svc.periodCloseAudit({ orgId, periodId });
    res.json({ data: out });
  } catch (e) { next(e); }
});

module.exports = router;
