const { z } = require("zod");

const partnerType = z.enum(["customer", "vendor"]);

const createPartnerSchema = z.object({
  type: partnerType,
  name: z.string().min(2),
  code: z.string().min(1).max(40).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(7).max(30).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  defaultReceivableAccountId: z.string().uuid().optional(),
  defaultPayableAccountId: z.string().uuid().optional(),
  paymentTermsId: z.string().uuid().optional(),
  notes: z.string().max(5000).optional()
});

const updatePartnerSchema = createPartnerSchema.partial();

const createContactSchema = z.object({
  name: z.string().min(2).max(200),
  email: z.string().email().optional(),
  phone: z.string().min(7).max(30).optional(),
  role: z.string().max(120).optional(),
  isPrimary: z.boolean().optional()
});

const updateContactSchema = createContactSchema.partial();

const createAddressSchema = z.object({
  label: z.string().max(60).optional(),
  line1: z.string().min(2).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  postalCode: z.string().max(40).optional(),
  country: z.string().max(120).optional(),
  isPrimary: z.boolean().optional()
});

const updateAddressSchema = createAddressSchema.partial();


const partnerTaxProfileSchema = z.object({
  taxregistrationNumber: z.string().max(120).optional().nullable(),
  legalName: z.string().max(200).optional().nullable(),
  taxClass: z.string().max(60).optional(),
  defaultTaxCodeId: z.string().uuid().optional().nullable(),
  purchaseTaxCodeId: z.string().uuid().optional().nullable(),
  salesTaxCodeId: z.string().uuid().optional().nullable(),
  jurisdictionId: z.string().uuid().optional().nullable(),
  placeOfSupply: z.string().max(120).optional().nullable(),
  isTaxRegistered: z.boolean().optional(),
  isTaxExempt: z.boolean().optional(),
  exemptionReasonCode: z.string().max(60).optional().nullable(),
  exemptionReason: z.string().max(500).optional().nullable(),
  reverseChargeApplicable: z.boolean().optional(),
  withholdingApplicable: z.boolean().optional(),
  withholdingTaxCodeId: z.string().uuid().optional().nullable(),
  withholdingRateOverride: z.coerce.number().min(0).max(1).optional().nullable(),
  recoverablePercentOverride: z.coerce.number().min(0).max(1).optional().nullable(),
  certificateReference: z.string().max(120).optional().nullable(),
  certificateExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  withholdingCertificateNo: z.string().max(120).optional().nullable(),
  filingContactEmail: z.string().email().optional().nullable(),
  customerTaxIdentifierType: z.string().max(40).optional().nullable(),
  vendorTaxIdentifierType: z.string().max(40).optional().nullable(),
  inputTaxRecoveryMode: z.enum(["default", "fully_recoverable", "partially_recoverable", "non_recoverable"]).optional().nullable(),
  destinationCountryCode: z.string().length(2).optional().nullable(),
  registrationStatus: z.enum(["registered", "unregistered", "pending", "suspended"]).optional().nullable(),
  eInvoiceNetwork: z.string().max(60).optional().nullable(),
  eInvoiceEndpoint: z.string().max(200).optional().nullable(),
  metadata: z.record(z.any()).optional()
});

const setPartnerTaxProfileSchema = partnerTaxProfileSchema;

const listPartnersQuerySchema = z.object({
  type: partnerType.optional(),
  status: z.enum(["active", "inactive"]).optional()
});

module.exports = {
  createPartnerSchema,
  updatePartnerSchema,
  createContactSchema,
  updateContactSchema,
  createAddressSchema,
  updateAddressSchema,
  listPartnersQuerySchema,
  setPartnerTaxProfileSchema
};
