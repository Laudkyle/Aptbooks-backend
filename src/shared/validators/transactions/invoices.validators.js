const { z } = require("zod");
const { moneyAmount, quantityAmount } = require("../financial.validators");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const taxSelectionSchema = z.object({
  taxCodeId: z.string().uuid(),
  taxableAmount: moneyAmount.optional(),
  taxAmount: moneyAmount.optional()
});

const lineSchema = z.object({
  description: z.string().min(2).max(500),
  quantity: quantityAmount.default("1"),
  unitPrice: moneyAmount,
  revenueAccountId: z.string().uuid(),
  taxCodeId: z.string().uuid().optional().nullable(),
  taxProfileId: z.string().uuid().optional().nullable(),
  itemId: z.string().uuid().optional().nullable(),
  supplyType: z.enum(['goods', 'services', 'mixed', 'import', 'export']).optional(),
  itemTaxCategory: z.string().max(60).optional().nullable(),
  taxTreatment: z.enum(['standard', 'zero_rated', 'exempt', 'relieved', 'out_of_scope', 'reverse_charge', 'import', 'export', 'non_recoverable']).optional(),
  placeOfSupplyCountryCode: z.string().length(2).optional().nullable(),
  taxAmount: moneyAmount.optional(),
  taxableAmount: moneyAmount.optional(),
  withholdingApplicable: z.coerce.boolean().optional(),
  withholdingTaxCodeId: z.string().uuid().optional().nullable(),
  withholdingRateOverride: z.coerce.number().min(0).max(100).optional(),
  recoverablePercentOverride: z.coerce.number().min(0).max(1).optional(),
  exemptionReasonCode: z.string().max(60).optional().nullable(),
  reverseCharge: z.coerce.boolean().optional(),
  lineTotal: moneyAmount.optional(),
  taxes: z.array(taxSelectionSchema).optional()
}).superRefine((val, ctx) => {
  if (val.taxCodeId && Array.isArray(val.taxes) && val.taxes.length) {
    ctx.addIssue({ code: 'custom', path: ['taxes'], message: 'Use either taxCodeId or taxes, not both' });
  }
});

const createInvoiceSchema = z.object({
  customerId: z.string().uuid(),
  invoiceDate: isoDate,
  dueDate: isoDate,
  memo: z.string().max(2000).optional(),
  currencyCode: z.string().length(3).optional(),
  taxDate: isoDate.optional(),
  pricingMode: z.enum(['exclusive', 'inclusive']).optional(),
  supplyType: z.enum(['goods', 'services', 'mixed', 'export', 'import']).optional(),
  placeOfSupplyCountryCode: z.string().length(2).optional(),
  buyerReference: z.string().max(255).optional(),
  jurisdictionId: z.string().uuid().optional().nullable(),
  lines: z.array(lineSchema).min(1)
}).superRefine((val, ctx) => {
  // Lexicographic compare works for YYYY-MM-DD
  if (val.dueDate < val.invoiceDate) {
    ctx.addIssue({
      code: "custom",
      path: ["dueDate"],
      message: "dueDate must be on or after invoiceDate"
    });
  }
});

const listInvoicesQuerySchema = z.object({
  status: z.enum(["draft", "issued", "paid", "voided"]).optional(),
  customerId: z.string().uuid().optional()
});

const voidInvoiceSchema = z.object({
  reason: z.string().min(2).max(500)
});

module.exports = {
  createInvoiceSchema,
  listInvoicesQuerySchema,
  voidInvoiceSchema
};
