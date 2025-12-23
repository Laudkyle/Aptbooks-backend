const { z, uuid, isoDate } = require("./common.validators");

const createPeriodSchema = z.object({
  code: z.string().min(1).max(50),
  startDate: isoDate,
  endDate: isoDate
});

const coaCreateSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  accountTypeCode: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
  categoryName: z.string().min(1).max(100).optional(),
  parentAccountId: uuid.optional(),
  isPostable: z.boolean().optional(),
  status: z.enum(["active", "inactive"]).optional()
});

const coaUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  categoryName: z.string().min(1).max(100).optional(),
  parentAccountId: uuid.nullable().optional(),
  isPostable: z.boolean().optional(),
  status: z.enum(["active", "inactive"]).optional()
}).refine(v => Object.keys(v).length > 0, "No fields provided");

const journalCreateSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  memo: z.string().max(500).optional(),
  idempotencyKey: z.string().max(120).optional(),
  typeCode: z.enum(["GENERAL", "ADJUSTMENT", "CLOSING"]).optional(),
  lines: z.array(z.object({
    accountId: uuid,
    description: z.string().max(300).optional(),
    debit: z.number().nonnegative().optional(),
    credit: z.number().nonnegative().optional()
  })).min(2)
}).superRefine((v, ctx) => {
  let debit = 0, credit = 0;
  for (const [i, l] of v.lines.entries()) {
    const d = Number(l.debit || 0);
    const c = Number(l.credit || 0);
    if ((d > 0 && c > 0) || (d === 0 && c === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Line ${i + 1} must have either debit or credit`, path: ["lines", i] });
    }
    debit += d; credit += c;
  }
  if (debit !== credit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Journal not balanced", path: ["lines"] });
  }
});

const voidSchema = z.object({
  reason: z.string().min(1).max(300)
});

module.exports = {
  createPeriodSchema,
  coaCreateSchema,
  coaUpdateSchema,
  journalCreateSchema,
  voidSchema
};
