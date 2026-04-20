const { z } = require("zod");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createJurisdictionSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  countryCode: z.string().length(2).optional()
});

const updateJurisdictionSchema = createJurisdictionSchema.partial();


const taxRuleConditionsSchema = z.record(z.string(), z.unknown()).optional();

const createTaxRuleSchema = z.object({
  code: z.string().min(1).max(80).optional().nullable(),
  name: z.string().min(1).max(200),
  documentType: z.string().max(80).optional().nullable(),
  partnerType: z.string().max(80).optional().nullable(),
  supplyType: z.enum(["goods", "services", "mixed", "import", "export"]).optional().nullable(),
  placeOfSupplyBasis: z.enum(["customer_location", "supplier_location", "ship_to", "service_performance"]).optional().nullable(),
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
  taxType: z.enum(["VAT", "GST", "SALES", "WHT", "WITHHOLDING", "IMPORT", "OTHER"]),
  taxCategory: z.enum(["standard", "zero_rated", "exempt", "reverse_charge", "withholding"]).optional(),
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
  metadata: z.record(z.string(), z.unknown()).optional()
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
  taxRoundingStrategy: z.enum(["line", "document", "total"]).optional(),
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
  scope: z.record(z.string(), z.unknown()).optional(),
  action: z.record(z.string(), z.unknown()).optional(),
  isEnabled: z.coerce.boolean().optional()
});
const createPartnerTaxProfileSchema = z.object({
  partnerId: z.string().uuid(),
  taxRegistrationNo: z.string().max(100).optional().nullable(),
  legalName: z.string().max(255).optional().nullable(),
  taxClass: z.enum(["standard", "small_business", "non_profit", "government"]).optional(),
  defaultTaxCodeId: z.string().uuid().optional().nullable(),
  purchaseTaxCodeId: z.string().uuid().optional().nullable(),
  salesTaxCodeId: z.string().uuid().optional().nullable(),
  jurisdictionId: z.string().uuid().optional().nullable(),
  placeOfSupply: z.string().max(50).optional().nullable(),
  isTaxRegistered: z.coerce.boolean().optional(),
  isTaxExempt: z.coerce.boolean().optional(),
  exemptionReasonCode: z.string().max(50).optional().nullable(),
  exemptionReason: z.string().max(255).optional().nullable(),
  reverseChargeApplicable: z.coerce.boolean().optional(),
  withholdingApplicable: z.coerce.boolean().optional(),
  withholdingTaxCodeId: z.string().uuid().optional().nullable(),
  recoverablePercentOverride: z.coerce.number().min(0).max(1).optional().nullable(),
  certificateReference: z.string().max(100).optional().nullable(),
  certificateExpiry: isoDate.optional().nullable(),
  withholdingRateOverride: z.coerce.number().min(0).max(100).optional().nullable(),
  withholdingCertificateNo: z.string().max(100).optional().nullable(),
  filingContactEmail: z.string().email().optional().nullable(),
  customerTaxIdentifierType: z.string().max(50).optional().nullable(),
  vendorTaxIdentifierType: z.string().max(50).optional().nullable(),
  inputTaxRecoveryMode: z.enum(["default", "fully_recoverable", "partially_recoverable", "non_recoverable"]).optional().nullable(),
  destinationCountryCode: z.string().length(2).optional().nullable(),
  registrationStatus: z.enum(["registered", "unregistered", "pending", "suspended"]).optional().nullable(),
  eInvoiceNetwork: z.string().max(100).optional().nullable(),
  eInvoiceEndpoint: z.string().max(255).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const updatePartnerTaxProfileSchema = createPartnerTaxProfileSchema.partial();

const taxReturnTemplateBoxSchema = z.object({
  boxCode: z.string().max(50),
  label: z.string().max(255),
  sortOrder: z.coerce.number().int().min(0).optional(),
  direction: z.enum(["input", "output"]).optional().nullable(),
  calculationFormula: z.string().optional().nullable(),
  isRequired: z.coerce.boolean().optional()
});

const createTaxReturnTemplateSchema = z.object({
  taxType: z.enum(["VAT", "GST", "SALES"]).optional(),
  code: z.string().max(50),
  name: z.string().max(255),
  description: z.string().optional().nullable(),
  isActive: z.coerce.boolean().optional(),
  boxes: z.array(taxReturnTemplateBoxSchema).optional()
});

const updateTaxReturnTemplateSchema = createTaxReturnTemplateSchema.partial();

const createTaxReturnSchema = z.object({
  taxType: z.enum(["VAT", "GST", "SALES", "WITHHOLDING", "IMPORT", "OTHER"]).optional(),
  filingPeriodStart: isoDate,
  filingPeriodEnd: isoDate,
  dueDate: isoDate.optional().nullable(),
  templateId: z.string().uuid().optional().nullable(),
  jurisdictionId: z.string().uuid().optional().nullable(),
  filingAdapterCode: z.string().max(80).optional().nullable()
}).superRefine((val, ctx) => {
  if (val.filingPeriodStart && val.filingPeriodEnd && val.filingPeriodEnd < val.filingPeriodStart) {
    ctx.addIssue({ code: "custom", path: ["filingPeriodEnd"], message: "filingPeriodEnd must be on or after filingPeriodStart" });
  }
});

const submitTaxReturnSchema = z.object({
  filingData: z.record(z.string(), z.unknown()),
  filingAdapterCode: z.string().max(80).optional().nullable()
});

const updateTaxReturnConfigSchema = z.object({
  defaultTemplateId: z.string().uuid().optional().nullable(),
  autoSubmitEnabled: z.coerce.boolean().optional(),
  notificationEmail: z.string().email().optional().nullable(),
  filingMethod: z.enum(["api", "manual", "email"]).optional().nullable()
});

const updateEinvoicingSettingsSchema = z.object({
  enabled: z.coerce.boolean().optional(),
  provider: z.string().max(100).optional().nullable(),
  apiEndpoint: z.string().url().optional().nullable(),
  apiKey: z.string().optional().nullable(),
  apiSecret: z.string().optional().nullable(),
  sandboxMode: z.coerce.boolean().optional(),
  documentTypes: z.array(z.string()).optional()
});

const createFilingAdapterSchema = z.object({
  adapterCode: z.string().max(80),
  name: z.string().max(150),
  channelType: z.enum(["api", "file", "manual"]).optional(),
  supportedTaxTypes: z.array(z.enum(["VAT", "GST", "SALES", "WITHHOLDING", "IMPORT", "OTHER"])).min(1).optional(),
  supportedCountries: z.array(z.string().length(2)).optional(),
  countryCode: z.string().length(2),
  configJson: z.record(z.string(), z.unknown()).optional(),
  isRealtime: z.coerce.boolean().optional(),
  isActive: z.coerce.boolean().optional()
});

const updateFilingAdapterSchema = createFilingAdapterSchema.partial();

const withholdingSourceLineSchema = z.object({
  sourceId: z.string().uuid(),
  appliedAmount: z.coerce.number().positive().optional(),
});

const createWithholdingRemittanceSchema = z.object({
  authorityPartnerId: z.string().uuid().optional().nullable(),
  jurisdictionId: z.string().uuid().optional().nullable(),
  taxCodeId: z.string().uuid().optional().nullable(),
  periodStart: isoDate.optional().nullable(),
  periodEnd: isoDate.optional().nullable(),
  remittanceDate: isoDate,
  currencyCode: z.string().min(1).max(10).optional().nullable(),
  settlementAccountId: z.string().uuid().optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
  memo: z.string().max(1000).optional().nullable(),
  lines: z.array(withholdingSourceLineSchema).min(1)
}).superRefine((val, ctx) => {
  if (val.periodStart && val.periodEnd && val.periodEnd < val.periodStart) {
    ctx.addIssue({ code: 'custom', path: ['periodEnd'], message: 'periodEnd must be on or after periodStart' });
  }
});

const updateWithholdingRemittanceSchema = createWithholdingRemittanceSchema.partial();

const postWithholdingRemittanceSchema = z.object({
  settlementAccountId: z.string().uuid().optional().nullable(),
  remittanceDate: isoDate.optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
  memo: z.string().max(1000).optional().nullable()
});

const createWithholdingCertificateSchema = z.object({
  customerId: z.string().uuid().optional().nullable(),
  jurisdictionId: z.string().uuid().optional().nullable(),
  taxCodeId: z.string().uuid().optional().nullable(),
  certificateNo: z.string().min(1).max(120),
  certificateDate: isoDate,
  counterAccountId: z.string().uuid().optional().nullable(),
  issuedBy: z.string().max(255).optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
  memo: z.string().max(1000).optional().nullable(),
  lines: z.array(withholdingSourceLineSchema).min(1)
});

const updateWithholdingCertificateSchema = createWithholdingCertificateSchema.partial();

const postWithholdingCertificateSchema = z.object({
  counterAccountId: z.string().uuid().optional().nullable(),
  certificateDate: isoDate.optional().nullable(),
  issuedBy: z.string().max(255).optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
  memo: z.string().max(1000).optional().nullable()
});

const voidWithholdingWorkflowSchema = z.object({
  reason: z.string().min(2).max(500)
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
  updateFilingAdapterSchema,
  createWithholdingRemittanceSchema,
  updateWithholdingRemittanceSchema,
  postWithholdingRemittanceSchema,
  createWithholdingCertificateSchema,
  updateWithholdingCertificateSchema,
  postWithholdingCertificateSchema,
  voidWithholdingWorkflowSchema
};
