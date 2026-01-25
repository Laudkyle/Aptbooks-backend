const router = require("express").Router(); 
const { authRequired } = require("../../../middleware/auth.middleware"); 
const { requirePermission } = require("../../../middleware/permission.middleware"); 
const { validate } = require("../../../shared/validators/validate"); 
const { z } = require("zod"); 
const svc = require("./payment-config.service"); 

router.use(authRequired); 

// ---- Payment terms (read)
router.get("/payment-terms", requirePermission("partners.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.listPaymentTerms({ orgId })); 
  } catch (e) { next(e);  }
}); 

// ---- Payment terms (manage)
const paymentTermPayloadSchema = z.object({
  name: z.string().min(1),
  netDays: z.number().int().nonnegative(),
  discountDays: z.number().int().nonnegative().nullable().optional(),
  discountRate: z.number().nonnegative().max(1).nullable().optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(["active","inactive"]).optional()
}); 

const paymentTermPatchSchema = z.object({
  name: z.string().min(1).optional(),
  netDays: z.number().int().nonnegative().optional(),
  discountDays: z.number().int().nonnegative().nullable().optional(),
  discountRate: z.number().nonnegative().max(1).nullable().optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(["active","inactive"]).optional()
}); 

router.post("/payment-terms", requirePermission("payment_config.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const payload = validate(paymentTermPayloadSchema, req.body); 
    res.status(201).json(await svc.createPaymentTerm({ orgId, payload })); 
  } catch (e) { next(e);  }
}); 

router.patch("/payment-terms/:id", requirePermission("payment_config.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const payload = validate(paymentTermPatchSchema, req.body || {}); 
    const out = await svc.updatePaymentTerm({ orgId, id: req.params.id, payload }); 
    res.json(out); 
  } catch (e) { next(e);  }
}); 

router.delete("/payment-terms/:id", requirePermission("payment_config.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const ok = await svc.deletePaymentTerm({ orgId, id: req.params.id }); 
    res.json({ ok }); 
  } catch (e) { next(e);  }
}); 

// ---- Payment methods (read)
router.get("/payment-methods", requirePermission("partners.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.listPaymentMethods({ orgId })); 
  } catch (e) { next(e);  }
}); 

// ---- Payment settings
const paymentSettingsSchema = z.object({
  arUnappliedAccountId: z.string().uuid().nullable().optional(),
  arDiscountAccountId: z.string().uuid().nullable().optional(),
  apPrepaymentsAccountId: z.string().uuid().nullable().optional(),
  apDiscountIncomeAccountId: z.string().uuid().nullable().optional(),

  // Stage 6: defaults for posting online payments
  onlineCashAccountId: z.string().uuid().nullable().optional(),
  onlinePaymentMethodId: z.string().uuid().nullable().optional()
}); 

router.get("/payment-settings", requirePermission("payment_config.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    res.json(await svc.getPaymentSettings({ orgId })); 
  } catch (e) { next(e);  }
}); 

router.put("/payment-settings", requirePermission("payment_config.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id; 
    const payload = validate(paymentSettingsSchema, req.body || {}); 
    res.json(await svc.upsertPaymentSettings({ orgId, payload })); 
  } catch (e) { next(e);  }
}); 

module.exports = router; 
