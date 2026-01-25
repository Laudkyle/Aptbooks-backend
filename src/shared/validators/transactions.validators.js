const { z } = require("zod");

/** =========================
 * Bills (AP)
 * ========================= */

const createBillLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive().optional(),
  unitPrice: z.number().nonnegative(),
  expenseAccountId: z.string().uuid()
});

const createBillSchema = z.object({
  vendorId: z.string().uuid(),
  billDate: z.string().min(8), // YYYY-MM-DD
  dueDate: z.string().min(8),  // YYYY-MM-DD
  memo: z.string().optional().nullable(),
  lines: z.array(createBillLineSchema).min(1)
});

const voidBillSchema = z.object({
  reason: z.string().min(2)
});

/** =========================
 * Vendor Payments (partial allocations)
 * ========================= */

const vendorPaymentAllocationSchema = z.object({
  billId: z.string().uuid(),
  amountApplied: z.number().positive()
});

const createVendorPaymentSchema = z.object({
  vendorId: z.string().uuid(),
  paymentDate: z.string().min(8), // YYYY-MM-DD
  paymentMethodId: z.string().uuid().optional().nullable(),
  cashAccountId: z.string().uuid(),
  amountTotal: z.number().nonnegative(),
  // Stage 3: allocations can be empty (prepayments/unapplied)
  allocations: z.array(vendorPaymentAllocationSchema).optional().default([])
});

const voidVendorPaymentSchema = z.object({
  reason: z.string().min(2)
});

/** =========================
 * Customer Receipts (partial allocations)
 * ========================= */

const customerReceiptAllocationSchema = z.object({
  invoiceId: z.string().uuid(),
  amountApplied: z.number().positive()
});

const createCustomerReceiptSchema = z.object({
  customerId: z.string().uuid(),
  receiptDate: z.string().min(8), // YYYY-MM-DD
  paymentMethodId: z.string().uuid().optional().nullable(),
  cashAccountId: z.string().uuid(),
  amountTotal: z.number().nonnegative(),
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
  quantity: z.number().positive().optional(),
  unitPrice: z.number().nonnegative(),
  revenueAccountId: z.string().uuid(),
  taxCodeId: z.string().uuid().optional().nullable(),
  taxAmount: z.number().nonnegative().optional()
});

const createCreditNoteSchema = z.object({
  customerId: z.string().uuid(),
  creditNoteDate: z.string().min(8),
  memo: z.string().optional().nullable(),
  lines: z.array(creditNoteLineSchema).min(1)
});

const applyCreditNoteSchema = z.object({
  invoiceId: z.string().uuid(),
  amountApplied: z.number().positive()
});

/** =========================
 * Debit Notes (AP adjustments)
 * ========================= */

const debitNoteLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive().optional(),
  unitPrice: z.number().nonnegative(),
  expenseAccountId: z.string().uuid(),
  taxCodeId: z.string().uuid().optional().nullable(),
  taxAmount: z.number().nonnegative().optional()
});

const createDebitNoteSchema = z.object({
  vendorId: z.string().uuid(),
  debitNoteDate: z.string().min(8),
  memo: z.string().optional().nullable(),
  lines: z.array(debitNoteLineSchema).min(1)
});

const applyDebitNoteSchema = z.object({
  billId: z.string().uuid(),
  amountApplied: z.number().positive()
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
