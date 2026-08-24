const { createModuleBodyContract, z, validateBody } = require("../../../shared/http/requestValidation");
const express = require("express");
const { requirePermission } = require("../../../middleware/permission.middleware");
const fx = require("../../../interfaces/fxManagement.interface");
const { authRequired } = require("../../../middleware/auth.middleware");

const router = express.Router();
router.use(createModuleBodyContract(['code', 'effectiveDate', 'fromCurrency', 'name', 'rate', 'rateTypeCode', 'toCurrency']));
router.use(authRequired);
const currencyCode = z.string().trim().regex(/^[A-Za-z]{3}$/).transform((v) => v.toUpperCase());
const rateValue = z.union([
  z.number().finite().positive(),
  z.string().trim().regex(/^\d+(?:\.\d{1,12})?$/, "rate must be a positive decimal with at most 12 places")
]);
const rateTypeSchema = z.object({ code: z.string().trim().min(1).max(50), name: z.string().trim().min(1).max(120) }).strict();
const fxRateSchema = z.object({
  rateTypeCode: z.string().trim().min(1).max(50),
  fromCurrency: currencyCode,
  toCurrency: currencyCode,
  rate: rateValue,
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict().refine((v) => v.fromCurrency !== v.toCurrency, { message: "Currencies must differ", path: ["toCurrency"] });

router.get("/rate-types", requirePermission("accounting.fx.read"), async (req, res, next) => {
  try {
    const data = await fx.listRateTypes();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/rate-types", requirePermission("accounting.fx.manage"), validateBody(rateTypeSchema), async (req, res, next) => {
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

router.put("/rates", requirePermission("accounting.fx.manage"), validateBody(fxRateSchema), async (req, res, next) => {
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
