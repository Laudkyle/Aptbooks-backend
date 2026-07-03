const { z, uuid, isoDate } = require("./common.validators");
const { parseDecimalToBigInt } = require("../utils/money");


const moneyAmount = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    return String(value);
  }
  if (typeof value === "string") return value.trim();
  return value;
}, z.string().regex(/^\d+(?:\.\d{1,2})?$/, "Amount must be a non-negative decimal with at most 2 decimal places"));

function amountToMinorUnits(value) {
  return parseDecimalToBigInt(value || "0", 2);
}

function addLineBalanceIssues(lines, ctx) {
  let debit = 0n;
  let credit = 0n;

  for (const [i, line] of lines.entries()) {
    let d = 0n;
    let c = 0n;

    try {
      d = amountToMinorUnits(line.debit);
      c = amountToMinorUnits(line.credit);
    } catch (_err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Line ${i + 1} contains an invalid amount`,
        path: ["lines", i]
      });
      continue;
    }

    if ((d > 0n && c > 0n) || (d === 0n && c === 0n)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Line ${i + 1} must have either debit or credit`,
        path: ["lines", i]
      });
    }

    debit += d;
    credit += c;
  }

  if (debit !== credit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Journal not balanced",
      path: ["lines"]
    });
  }
}

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
  memo: z.string().trim().min(1, "Memo is required").max(500),
  idempotencyKey: z.string().max(120).optional(),
  typeCode: z.enum(["GENERAL", "ADJUSTMENT", "CLOSING"]).optional(),
  lines: z.array(z.object({
    accountId: uuid,
    description: z.string().trim().min(1, "Line description is required").max(300),
    debit: moneyAmount.optional(),
    credit: moneyAmount.optional()
  })).min(2)
}).superRefine((v, ctx) => {
  addLineBalanceIssues(v.lines, ctx);
});

const voidSchema = z.object({
  reason: z.string().min(1).max(300)
});

// -----------------------------
// Stage 2: journal lifecycle and editing
// -----------------------------
const journalHeaderUpdateSchema = z
  .object({
    periodId: uuid.optional(),
    entryDate: isoDate.optional(),
    memo: z.string().trim().min(1, "Memo is required").max(500).optional(),
    typeCode: z.enum(["GENERAL", "ADJUSTMENT", "CLOSING"]).optional()
  })
  .refine((v) => Object.keys(v).length > 0, "No fields provided");

const journalLineSchema = z.object({
  accountId: uuid,
  description: z.string().trim().min(1, "Line description is required").max(300),
  debit: moneyAmount.optional(),
  credit: moneyAmount.optional()
});

const journalLinesReplaceSchema = z
  .object({
    lines: z.array(journalLineSchema).min(2)
  })
  .superRefine((v, ctx) => {
    addLineBalanceIssues(v.lines, ctx);
  });

const journalLineAddSchema = journalLineSchema;

const journalLineUpdateSchema = z
  .object({
    accountId: uuid.optional(),
    description: z.string().trim().min(1, "Line description is required").max(300),
    debit: moneyAmount.optional(),
    credit: moneyAmount.optional()
  })
  .refine((v) => Object.keys(v).length > 0, "No fields provided")
  .superRefine((v, ctx) => {
    if (v.debit === undefined && v.credit === undefined) return;

    let debit = 0n;
    let credit = 0n;
    try {
      debit = amountToMinorUnits(v.debit);
      credit = amountToMinorUnits(v.credit);
    } catch (_err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid amount", path: [] });
      return;
    }

    if ((debit > 0n && credit > 0n) || (debit === 0n && credit === 0n)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Line must have either debit or credit",
        path: []
      });
    }
  });

const journalRejectSchema = z.object({
  reason: z.string().min(1).max(300)
});

const journalBatchPostSchema = z.object({
  journalIds: z.array(uuid).min(1),
  idempotencyKey: z.string().max(120).optional()
});

module.exports = {
  createPeriodSchema,
  coaCreateSchema,
  coaUpdateSchema,
  journalCreateSchema,
  voidSchema,
  journalHeaderUpdateSchema,
  journalLinesReplaceSchema,
  journalLineAddSchema,
  journalLineUpdateSchema,
  journalRejectSchema,
  journalBatchPostSchema
};
