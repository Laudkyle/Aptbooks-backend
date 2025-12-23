const { z } = require("zod");

const lineSchema = z.object({
  description: z.string().min(2).max(500),
  quantity: z.coerce.number().positive().default(1),
  unitPrice: z.coerce.number().min(0),
  revenueAccountId: z.string().uuid()
});

const createInvoiceSchema = z.object({
  customerId: z.string().uuid(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(2000).optional(),
  lines: z.array(lineSchema).min(1)
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
