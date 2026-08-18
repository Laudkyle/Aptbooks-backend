const { z } = require("zod");
const { moneyAmount, positiveMoneyAmount, quantityAmount } = require("./financial.validators");

const taxSelectionSchema = z.object({
  taxCodeId: z.string().uuid(),
  taxableAmount: moneyAmount.optional(),
  taxAmount: moneyAmount.optional()
});


/** =========================
 * Bills (AP)
 * ========================= */

const createBillLineSchema = z.object({
  description: z.string().min(1),
  quantity: quantityAmount.optional(),
  unitPrice: moneyAmount,
  expenseAccountId: z.string().uuid(),
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

const createBillSchema = z.object({
  vendorId: z.string().uuid(),
  billDate: z.string().min(8), // YYYY-MM-DD
  dueDate: z.string().min(8),  // YYYY-MM-DD
  memo: z.string().optional().nullable(),
  currencyCode: z.string().length(3).optional(),
  taxDate: z.string().min(8).optional(),
  pricingMode: z.enum(['exclusive', 'inclusive']).optional(),
  supplyType: z.enum(['goods', 'services', 'mixed', 'import', 'export']).optional(),
  placeOfSupplyCountryCode: z.string().length(2).optional(),
  supplierReference: z.string().max(255).optional().nullable(),
  jurisdictionId: z.string().uuid().optional().nullable(),
  lines: z.array(createBillLineSchema).min(1)
});

const voidBillSchema = z.object({
  reason: z.string().min(2)
});

/** =========================
 * Vendor Payments (partial allocations)
 * ========================= */

const vendorPaymentAllocationSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return {
      ...val,
      amountApplied: val.amountApplied ?? val.amount
    };
  }
  return val;
}, z.object({
  billId: z.string().uuid(),
  amountApplied: positiveMoneyAmount
}));

const createVendorPaymentSchema = z.object({
  vendorId: z.string().uuid(),
  paymentDate: z.string().min(8), // YYYY-MM-DD
  paymentMethodId: z.string().uuid().optional().nullable(),
  cashAccountId: z.string().uuid().optional().nullable(),
  amountTotal: moneyAmount,
  // Stage 3: allocations can be empty (prepayments/unapplied)
  allocations: z.array(vendorPaymentAllocationSchema).optional().default([])
});

const voidVendorPaymentSchema = z.object({
  reason: z.string().min(2)
});

/** =========================
 * Customer Receipts (partial allocations)
 * ========================= */

const customerReceiptAllocationSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return {
      ...val,
      amountApplied: val.amountApplied ?? val.amount
    };
  }
  return val;
}, z.object({
  invoiceId: z.string().uuid(),
  amountApplied: positiveMoneyAmount
}));

const createCustomerReceiptSchema = z.object({

  customerId: z.string().uuid(),
  receiptDate: z.string().min(8), // YYYY-MM-DD
  paymentMethodId: z.string().uuid().optional().nullable(),
  cashAccountId: z.string().uuid().optional().nullable(),
  amountTotal: moneyAmount,
  memo: z.string().optional().nullable(),
  // Stage 3: allocations can be empty (unapplied cash)
  allocations: z.array(customerReceiptAllocationSchema).optional().default([])
});

const voidCustomerReceiptSchema = z.object({
  reason: z.string().min(2)
});

/** =========================
 * Credit Notes (AR adjustments)
 * ========================= */

const creditNoteLineSchema = z.object({
  description: z.string().min(1),
  quantity: quantityAmount.optional(),
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

const createCreditNoteSchema = z.object({
  customerId: z.string().uuid(),
  creditNoteDate: z.string().min(8),
  memo: z.string().optional().nullable(),
  lines: z.array(creditNoteLineSchema).min(1)
});

const applyCreditNoteSchema = z.object({
  invoiceId: z.string().uuid(),
  amountApplied: positiveMoneyAmount
});

/** =========================
 * Debit Notes (AP adjustments)
 * ========================= */

const debitNoteLineSchema = z.object({
  description: z.string().min(1),
  quantity: quantityAmount.optional(),
  unitPrice: moneyAmount,
  expenseAccountId: z.string().uuid(),
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

const createDebitNoteSchema = z.object({
  vendorId: z.string().uuid(),
  debitNoteDate: z.string().min(8),
  memo: z.string().optional().nullable(),
  lines: z.array(debitNoteLineSchema).min(1)
});

const applyDebitNoteSchema = z.object({
  billId: z.string().uuid(),
  amountApplied: positiveMoneyAmount
});

/** =========================
 * Allocation maintenance (Stage 3)
 * ========================= */

const reallocateCustomerReceiptSchema = z.object({
  allocations: z.array(customerReceiptAllocationSchema).optional().default([])
});

const autoAllocateCustomerReceiptSchema = z.object({
  rule: z.enum(["due_date", "fifo"]).optional().default("due_date")
});

const reallocateVendorPaymentSchema = z.object({
  allocations: z.array(vendorPaymentAllocationSchema).optional().default([])
});

const autoAllocateVendorPaymentSchema = z.object({
  rule: z.enum(["due_date", "fifo"]).optional().default("due_date")
});

module.exports = {
  // bills
  createBillSchema,
  voidBillSchema,

  // vendor payments
  createVendorPaymentSchema,
  voidVendorPaymentSchema,
  reallocateVendorPaymentSchema,
  autoAllocateVendorPaymentSchema,

  // customer receipts
  createCustomerReceiptSchema,
  voidCustomerReceiptSchema,
  reallocateCustomerReceiptSchema,
  autoAllocateCustomerReceiptSchema,

  // credit notes
  createCreditNoteSchema,
  applyCreditNoteSchema,

  // debit notes
  createDebitNoteSchema,
  applyDebitNoteSchema
};
