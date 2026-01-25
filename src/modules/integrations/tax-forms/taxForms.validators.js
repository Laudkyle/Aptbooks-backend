const { z } = require("zod"); 

const upsertVendorTaxProfileSchema = z.object({
  tin: z.string().optional(),
  legalName: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  stateProvince: z.string().optional(),
  postalCode: z.string().optional(),
  countryCode: z.string().optional(),
  classification: z.string().optional(),
  isReportable: z.boolean().optional(),
  metadata: z.record(z.any()).optional()
}); 

const createTaxFormRunSchema = z.object({
  taxYear: z.number().int().min(1900).max(2100),
  formType: z.string().optional()
}); 

module.exports = { upsertVendorTaxProfileSchema, createTaxFormRunSchema }; 
