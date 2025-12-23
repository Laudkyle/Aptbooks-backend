const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const svc = require("./payment-config.service");

router.use(authRequired);

router.get("/payment-terms", requirePermission("partners.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listPaymentTerms({ orgId }));
  } catch (e) { next(e); }
});

router.get("/payment-methods", requirePermission("partners.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.listPaymentMethods({ orgId }));
  } catch (e) { next(e); }
});

module.exports = router;
