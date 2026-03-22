const express = require("express");
const { requirePermission } = require("../../../middleware/permission.middleware");
const reconcile = require("../../../interfaces/reconciliation.interface");
const { authRequired } = require("../../../middleware/auth.middleware");
const router = express.Router();
router.use(authRequired);

router.get("/period", requirePermission("accounting.reconcile.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId } = req.query;
    const data = await reconcile.reconcilePeriod({ orgId, periodId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
