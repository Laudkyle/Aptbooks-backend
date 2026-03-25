
const { z } = require("zod");

const taxSelectionSchema = z.object({
  taxCodeId: z.string().uuid(),
  taxableAmount: z.number().nonnegative().optional(),
  taxAmount: z.number().nonnegative().optional()
});

const lineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive().optional(),
  unitPrice: z.number().nonnegative().optional(),
  lineTotal: z.number().nonnegative().optional(),
  taxableAmount: z.number().nonnegative().optional(),
  taxAmount: z.number().nonnegative().optional(),
  accountId: z.string().uuid().optional().nullable(),
  itemId: z.string().uuid().optional().nullable(),
  taxCodeId: z.string().uuid().optional().nullable(),
  taxes: z.array(taxSelectionSchema).optional(),
  meta: z.record(z.any()).optional().nullable()
}).superRefine((val, ctx) => {
  if (val.taxCodeId && Array.isArray(val.taxes) && val.taxes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taxes'], message: 'Use either taxCodeId or taxes, not both' });
  }
});

const postingLineSchema = lineSchema.safeExtend({
  accountId: z.string().uuid()
});

const voidSchema = z.object({
  reason: z.string().min(2)
});

const baseCreateSchema = z.object({
  date: z.string().min(8),
  dueDate: z.string().min(8).optional().nullable(),
  partnerId: z.string().uuid().optional().nullable(),
  employeeId: z.string().uuid().optional().nullable(),
  cashAccountId: z.string().uuid().optional().nullable(),
  primaryAccountId: z.string().uuid().optional().nullable(),
  sourceDocumentId: z.string().uuid().optional().nullable(),
  reference: z.string().optional().nullable(),
  memo: z.string().optional().nullable(),
  amountTotal: z.number().nonnegative().optional(),
  currencyCode: z.string().min(3).max(3).optional().nullable(),
  meta: z.record(z.any()).optional().nullable(),
  lines: z.array(lineSchema).optional().default([])
});

const quotationSchema = baseCreateSchema.extend({
  partnerId: z.string().uuid(),
  lines: z.array(postingLineSchema).min(1)
});

const salesOrderSchema = baseCreateSchema.extend({
  partnerId: z.string().uuid(),
  dueDate: z.string().min(8),
  lines: z.array(lineSchema).min(1)
});

const purchaseRequisitionSchema = baseCreateSchema.extend({
  lines: z.array(lineSchema).min(1)
});

const purchaseOrderSchema = baseCreateSchema.extend({
  partnerId: z.string().uuid(),
  dueDate: z.string().min(8),
  lines: z.array(lineSchema).min(1)
});

const goodsReceiptSchema = baseCreateSchema.extend({
  partnerId: z.string().uuid().optional().nullable(),
  primaryAccountId: z.string().uuid(),
  sourceDocumentId: z.string().uuid().optional().nullable(),
  lines: z.array(postingLineSchema).min(1)
});

const expenseSchema = baseCreateSchema.extend({
  primaryAccountId: z.string().uuid(),
  lines: z.array(postingLineSchema).min(1)
});

const pettyCashSchema = baseCreateSchema.extend({
  cashAccountId: z.string().uuid(),
  primaryAccountId: z.string().uuid().optional().nullable(),
  lines: z.array(postingLineSchema).min(1)
});

const advanceSchema = baseCreateSchema.extend({
  advanceType: z.enum(["customer", "vendor", "staff"]),
  partnerId: z.string().uuid().optional().nullable(),
  employeeId: z.string().uuid().optional().nullable(),
  cashAccountId: z.string().uuid(),
  primaryAccountId: z.string().uuid(),
  amountTotal: z.number().positive(),
  lines: z.array(lineSchema).optional().default([])
}).superRefine((val, ctx) => {
  if (val.advanceType === "staff" && !val.employeeId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["employeeId"], message: "employeeId is required for staff advances" });
  }
  if ((val.advanceType === "customer" || val.advanceType === "vendor") && !val.partnerId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partnerId"], message: "partnerId is required for customer/vendor advances" });
  }
});

const returnSchema = baseCreateSchema.extend({
  returnType: z.enum(["sales_return", "purchase_return"]),
  partnerId: z.string().uuid(),
  sourceDocumentId: z.string().uuid().optional().nullable(),
  lines: z.array(postingLineSchema).min(1)
});

const refundSchema = baseCreateSchema.extend({
  refundType: z.enum(["customer_refund", "vendor_refund"]),
  partnerId: z.string().uuid(),
  cashAccountId: z.string().uuid(),
  primaryAccountId: z.string().uuid(),
  amountTotal: z.number().positive(),
  lines: z.array(lineSchema).optional().default([])
});

module.exports = {
  voidSchema,
  quotationSchema,
  salesOrderSchema,
  purchaseRequisitionSchema,
  purchaseOrderSchema,
  goodsReceiptSchema,
  expenseSchema,
  pettyCashSchema,
  advanceSchema,
  returnSchema,
  refundSchema
};
