const { z, uuid, isoDate } = require("./common.validators");

const accrualRuleLineSchema = z.object({
  accountId: uuid,
  dc: z.enum(["debit", "credit"]),
  amountValue: z.number().nonnegative(),
  description: z.string().max(300).optional()
});

const createAccrualRuleSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),

  ruleType: z.enum(["REVERSING", "RECURRING", "DEFERRAL", "DERIVED"]),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "PERIOD_END", "ON_DEMAND"]),

  autoReverse: z.boolean().optional(),
  reverseTiming: z.enum(["NEXT_PERIOD_START"]).optional(),

  startDate: isoDate.optional(),
  endDate: isoDate.optional(),

  status: z.enum(["active", "inactive"]).optional(),

  lines: z.array(accrualRuleLineSchema).min(2)
}).superRefine((v, ctx) => {
  // enforce balanced template for fixed-value rules
  let debit = 0, credit = 0;
  for (const [i, l] of v.lines.entries()) {
    const amt = Number(l.amountValue || 0);
    if (amt <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Line ${i + 1} amountValue must be > 0`, path: ["lines", i, "amountValue"] });
    }
    if (l.dc === "debit") debit += amt;
    else credit += amt;
  }
  if (Number(debit.toFixed(2)) !== Number(credit.toFixed(2))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Accrual rule lines not balanced", path: ["lines"] });
  }

  // reversing constraints
  if (v.ruleType === "REVERSING") {
    if (v.autoReverse !== true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "REVERSING rules must have autoReverse=true", path: ["autoReverse"] });
    }
    if (v.reverseTiming && v.reverseTiming !== "NEXT_PERIOD_START") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid reverseTiming", path: ["reverseTiming"] });
    }
  }
});

const runDueAccrualsSchema = z.object({
  asOfDate: isoDate
});

const runPeriodEndAccrualsSchema = z.object({
  periodId: uuid,
  asOfDate: isoDate.optional()
});

module.exports = {
  createAccrualRuleSchema,
  runDueAccrualsSchema,
  runPeriodEndAccrualsSchema
};
