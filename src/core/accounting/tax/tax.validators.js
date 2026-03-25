const { z } = require("zod");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createJurisdictionSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  countryCode: z.string().length(2).optional()
});

const updateJurisdictionSchema = createJurisdictionSchema.partial();


const taxRuleConditionsSchema = z.record(z.any()).optional();

const createTaxRuleSchema = z.object({
  name: z.string().min(1).max(200),
  documentType: z.string().max(80).optional().nullable(),
  partnerType: z.string().max(80).optional().nullable(),
  transactionScope: z.enum(["sales", "purchases", "both"]).optional(),
  jurisdictionId: z.string().uuid().optional().nullable(),
  taxCodeId: z.string().uuid(),
  priority: z.coerce.number().int().min(0).optional(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.optional().nullable(),
  conditions: taxRuleConditionsSchema,
  status: z.enum(["active", "inactive"]).optional()
}).superRefine((val, ctx) => {
  if (val.effectiveFrom && val.effectiveTo && val.effectiveTo < val.effectiveFrom) {
    ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must be on or after effectiveFrom" });
  }
});

const updateTaxRuleSchema = createTaxRuleSchema.partial();

const createTaxCodeSchema = z.object({
  jurisdictionId: z.string().uuid().nullable().optional(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  taxType: z.enum(["VAT", "GST", "SALES", "WITHHOLDING", "IMPORT", "OTHER"]),
  rate: z.coerce.number().min(0),
  isCompound: z.coerce.boolean().optional(),
  // Optional mapping used by VAT/tax return reporting.
  // boxCode is the return "box" identifier (e.g., "BOX_1").
  boxCode: z.string().min(1).max(50).optional().nullable(),
  // direction indicates whether the tax is output (sales) or input (purchases).
  direction: z.enum(["output", "input"]).optional().nullable(),
  categoryCode: z.string().max(30).optional().nullable(),
  taxScope: z.enum(["taxable", "zero_rated", "exempt", "out_of_scope", "reverse_charge", "withholding", "import", "export", "non_recoverable"]).optional(),
  applicationScope: z.enum(["sales", "purchases", "both"]).optional(),
  calculationMethod: z.enum(["standard", "inclusive", "deduction", "withholding"]).optional(),
  exemptionReasonCode: z.string().max(60).optional().nullable(),
  exemptionReason: z.string().max(500).optional().nullable(),
  reverseCharge: z.coerce.boolean().optional(),
  recoverablePercent: z.coerce.number().min(0).max(1).optional(),
  reportingGroup: z.string().max(60).optional().nullable(),
  postingAccountId: z.string().uuid().optional().nullable(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.optional().nullable(),
  status: z.enum(["active", "inactive"]).optional()
}).superRefine((val, ctx) => {
  if (val.effectiveFrom && val.effectiveTo && val.effectiveTo < val.effectiveFrom) {
    ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must be on or after effectiveFrom" });
  }
});

const updateTaxCodeSchema = createTaxCodeSchema.partial();



const createTaxRegistrationSchema = z.object({
  jurisdictionId: z.string().uuid().nullable().optional(),
  registrationNumber: z.string().min(1).max(120),
  registrationType: z.enum(["VAT", "GST", "SALES_TAX", "WITHHOLDING", "PAYE", "OTHER"]).optional(),
  legalEntityName: z.string().max(255).optional().nullable(),
  filingFrequency: z.enum(["monthly", "bi_monthly", "quarterly", "semi_annual", "annual", "ad_hoc"]).optional(),
  filingBasis: z.enum(["invoice", "cash", "hybrid"]).optional(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.optional().nullable(),
  isPrimary: z.coerce.boolean().optional(),
  metadata: z.record(z.any()).optional()
}).superRefine((val, ctx) => {
  if (val.effectiveFrom && val.effectiveTo && val.effectiveTo < val.effectiveFrom) {
    ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must be on or after effectiveFrom" });
  }
});

const updateTaxRegistrationSchema = createTaxRegistrationSchema.partial();

const createTaxAdjustmentSchema = z.object({
  adjustmentDate: isoDate,
  taxType: z.enum(["VAT", "GST", "SALES", "WITHHOLDING", "IMPORT", "OTHER"]).default("VAT"),
  direction: z.enum(["output", "input"]),
  boxCode: z.string().min(1).max(50).optional().nullable(),
  description: z.string().min(2).max(500),
  amount: z.coerce.number().refine((v) => Number(v) !== 0, { message: "amount must not be zero" }),
  accountId: z.string().uuid().optional().nullable(),
  counterAccountId: z.string().uuid().optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
  autoPost: z.coerce.boolean().optional()
});

const voidTaxAdjustmentSchema = z.object({
  reason: z.string().min(2).max(500)
});

const taxComponentSchema = z.object({
  componentTaxCodeId: z.string().uuid(),
  sequenceNo: z.coerce.number().int().positive().optional(),
  rateOverride: z.coerce.number().nonnegative().optional().nullable()
});

const setTaxCodeComponentsSchema = z.object({
  components: z.array(taxComponentSchema).min(1)
});

const setTaxSettingsSchema = z.object({
  outputTaxAccountId: z.string().uuid().nullable().optional(),
  inputTaxAccountId: z.string().uuid().nullable().optional(),
  defaultTaxCodeId: z.string().uuid().nullable().optional(),
  nonRecoverableInputTaxAccountId: z.string().uuid().nullable().optional(),
  withholdingTaxPayableAccountId: z.string().uuid().nullable().optional(),
  withholdingTaxReceivableAccountId: z.string().uuid().nullable().optional(),
  reverseChargeTaxAccountId: z.string().uuid().nullable().optional(),
  taxRoundingStrategy: z.enum(["line", "document"]).optional(),
  enforcePartnerTaxProfile: z.coerce.boolean().optional(),
  requireTaxJurisdiction: z.coerce.boolean().optional()
});




const installCountryPackSchema = z.object({
  packCode: z.string().min(2).max(40).optional(),
  countryCode: z.string().min(2).max(40).optional()
}).refine((v) => !!(v.packCode || v.countryCode), { message: "packCode or countryCode is required" });

const upsertTaxAutomationRuleSchema = z.object({
  name: z.string().min(2).max(120),
  triggerCode: z.enum(["return_due", "invoice_issued", "bill_issued", "einvoice_generated", "reconciliation_exception"]),
  scheduleCode: z.enum(["manual", "hourly", "daily", "weekly"]).optional(),
  scope: z.record(z.any()).optional(),
  action: z.record(z.any()).optional(),
  isEnabled: z.coerce.boolean().optional()
});
module.exports = {
  createTaxRegistrationSchema,
  updateTaxRegistrationSchema,
  createJurisdictionSchema,
  updateJurisdictionSchema,
  createTaxCodeSchema,
  updateTaxCodeSchema,
  createTaxRuleSchema,
  updateTaxRuleSchema,
  setTaxSettingsSchema,
  createTaxAdjustmentSchema,
  voidTaxAdjustmentSchema,
  setTaxCodeComponentsSchema,
  installCountryPackSchema,
  upsertTaxAutomationRuleSchema
};