const { z } = require("zod");
const Joi = require("joi");
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
  direction: z.enum(["output", "input", "both", "withholding", "reverse_charge"]).optional().nullable(),
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
// Add these to your existing validators file

const createPartnerTaxProfileSchema = Joi.object({
  partnerId: Joi.string().uuid().required(),
  taxRegistrationNo: Joi.string().max(100).allow(null),
  legalName: Joi.string().max(255).allow(null),
  taxClass: Joi.string().valid('standard', 'small_business', 'non_profit', 'government').default('standard'),
  defaultTaxCodeId: Joi.string().uuid().allow(null),
  purchaseTaxCodeId: Joi.string().uuid().allow(null),
  salesTaxCodeId: Joi.string().uuid().allow(null),
  jurisdictionId: Joi.string().uuid().allow(null),
  placeOfSupply: Joi.string().max(50).allow(null),
  isTaxRegistered: Joi.boolean().default(false),
  isTaxExempt: Joi.boolean().default(false),
  exemptionReasonCode: Joi.string().max(50).allow(null),
  exemptionReason: Joi.string().max(255).allow(null),
  reverseChargeApplicable: Joi.boolean().default(false),
  withholdingApplicable: Joi.boolean().default(false),
  withholdingTaxCodeId: Joi.string().uuid().allow(null),
  recoverablePercentOverride: Joi.number().min(0).max(1).precision(4).allow(null),
  certificateReference: Joi.string().max(100).allow(null),
  certificateExpiry: Joi.date().allow(null),
  withholdingRateOverride: Joi.number().min(0).max(100).precision(2).allow(null),
  withholdingCertificateNo: Joi.string().max(100).allow(null),
  filingContactEmail: Joi.string().email().allow(null),
  customerTaxIdentifierType: Joi.string().max(50).allow(null),
  vendorTaxIdentifierType: Joi.string().max(50).allow(null),
  metadata: Joi.object().default({})
});

const updatePartnerTaxProfileSchema = createPartnerTaxProfileSchema.fork(
  Object.keys(createPartnerTaxProfileSchema.describe().keys),
  (schema) => schema.optional()
);

const createTaxReturnTemplateSchema = Joi.object({
  taxType: Joi.string().valid('VAT', 'GST', 'SALES').default('VAT'),
  code: Joi.string().max(50).required(),
  name: Joi.string().max(255).required(),
  description: Joi.string().allow(null),
  isActive: Joi.boolean().default(true),
  boxes: Joi.array().items(Joi.object({
    boxCode: Joi.string().max(50).required(),
    label: Joi.string().max(255).required(),
    sortOrder: Joi.number().integer().min(0).default(0),
    direction: Joi.string().valid('input', 'output').allow(null),
    calculationFormula: Joi.string().allow(null),
    isRequired: Joi.boolean().default(false)
  }))
});

const updateTaxReturnTemplateSchema = createTaxReturnTemplateSchema.fork(
  ['code'],
  (schema) => schema.optional()
);

const createTaxReturnSchema = Joi.object({
  taxType: Joi.string().valid('VAT', 'GST', 'SALES', 'WITHHOLDING', 'IMPORT', 'OTHER').default('VAT'),
  filingPeriodStart: Joi.date().required(),
  filingPeriodEnd: Joi.date().required(),
  dueDate: Joi.date().allow(null),
  templateId: Joi.string().uuid().allow(null),
  jurisdictionId: Joi.string().uuid().allow(null),
  filingAdapterCode: Joi.string().max(80).allow(null)
});

const submitTaxReturnSchema = Joi.object({
  filingData: Joi.object().required(),
  filingAdapterCode: Joi.string().max(80).allow(null)
});

const updateTaxReturnConfigSchema = Joi.object({
  defaultTemplateId: Joi.string().uuid().allow(null),
  autoSubmitEnabled: Joi.boolean(),
  notificationEmail: Joi.string().email().allow(null),
  filingMethod: Joi.string().valid('api', 'manual', 'email')
});

const updateEinvoicingSettingsSchema = Joi.object({
  enabled: Joi.boolean(),
  provider: Joi.string().max(100).allow(null),
  apiEndpoint: Joi.string().uri().allow(null),
  apiKey: Joi.string().allow(null),
  apiSecret: Joi.string().allow(null),
  sandboxMode: Joi.boolean(),
  documentTypes: Joi.array().items(Joi.string())
});

const createFilingAdapterSchema = Joi.object({
  adapterCode: Joi.string().max(80).required(),
  name: Joi.string().max(150).required(),
  channelType: Joi.string().valid('api', 'file', 'manual').default('api'),
  supportedTaxTypes: Joi.array().items(Joi.string().valid('VAT', 'GST', 'SALES', 'WITHHOLDING', 'IMPORT', 'OTHER')).min(1).default(['VAT']),
  supportedCountries: Joi.array().items(Joi.string().length(2)).default([]),
  countryCode: Joi.string().length(2).required(),
  configJson: Joi.object().default({}),
  isRealtime: Joi.boolean().default(false),
  isActive: Joi.boolean().default(true)
});

const updateFilingAdapterSchema = createFilingAdapterSchema.fork(
  ['adapterCode', 'name', 'countryCode'],
  (schema) => schema.optional()
);
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
  upsertTaxAutomationRuleSchema,
  createPartnerTaxProfileSchema,
  updatePartnerTaxProfileSchema,
  createTaxReturnTemplateSchema,
  updateTaxReturnTemplateSchema,
  createTaxReturnSchema,
  submitTaxReturnSchema,
  updateTaxReturnConfigSchema,
  updateEinvoicingSettingsSchema,
  createFilingAdapterSchema,
  updateFilingAdapterSchema
};