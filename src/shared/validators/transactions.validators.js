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
  billDate: z.string().min(8),  // YYYY-MM-DD
  dueDate: z.string().min(8),   // YYYY-MM-DD
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
  allocations: z.array(vendorPaymentAllocationSchema).min(1)
});

const voidVendorPaymentSchema = z.object({
  reason: z.string().min(2)
});

module.exports = {
  // bills
  createBillSchema,
  voidBillSchema,

  // vendor payments
  createVendorPaymentSchema,
  voidVendorPaymentSchema
};
