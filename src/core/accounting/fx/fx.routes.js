const express = require("express");
const { requirePermission } = require("../../../middleware/permission.middleware");
const fx = require("../../../interfaces/fxManagement.interface");
const { authRequired } = require("../../../middleware/auth.middleware");

const router = express.Router();
router.use(authRequired);

router.get("/rate-types", requirePermission("accounting.fx.read"), async (req, res, next) => {
  try {
    const data = await fx.listRateTypes();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/rate-types", requirePermission("accounting.fx.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { code, name } = req.body;
    const data = await fx.createRateType({ orgId, code, name, actorUserId, req });
    res.status(201).json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/rates", requirePermission("accounting.fx.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { rateTypeCode, fromCurrency, toCurrency, fromDate, toDate, limit } = req.query;
    const data = await fx.listRates({ orgId, rateTypeCode, fromCurrency, toCurrency, fromDate, toDate, limit });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.put("/rates", requirePermission("accounting.fx.manage"), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { rateTypeCode, fromCurrency, toCurrency, rate, effectiveDate } = req.body;
    const data = await fx.upsertRate({ orgId, rateTypeCode, fromCurrency, toCurrency, rate, effectiveDate, actorUserId, req });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/rates/effective", requirePermission("accounting.fx.read"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { rateTypeCode, fromCurrency, toCurrency, asOfDate } = req.query;
    const data = await fx.getEffectiveRate({ orgId, rateTypeCode, fromCurrency, toCurrency, asOfDate });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
