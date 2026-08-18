const { z, uuid, isoDate } = require("./common.validators");
const { positiveMoneyAmount } = require("./financial.validators");
const { parseDecimalToBigInt } = require("../utils/money");

const accrualRuleLineSchema = z.object({
  accountId: uuid,
  dc: z.enum(["debit", "credit"]),
  amountValue: positiveMoneyAmount,
  description: z.string().max(300).optional(),
});
const deferralScheduleSchema = z.object({
  totalAmount: positiveMoneyAmount,
  periodCount: z.coerce.number().int().positive(),
  startPeriodId: z.uuid()
});
const createAccrualRuleSchema = z
  .object({
    code: z.string().min(1).max(50),
    name: z.string().min(1).max(200),

    ruleType: z.enum(["REVERSING", "RECURRING", "DEFERRAL", "DERIVED"]),
    frequency: z.enum([
      "DAILY",
      "WEEKLY",
      "MONTHLY",
      "PERIOD_END",
      "ON_DEMAND",
    ]),

    autoReverse: z.boolean().optional(),
    reverseTiming: z.enum(["NEXT_PERIOD_START"]).optional(),
    isRequired: z.boolean().optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),

    status: z.enum(["active", "inactive"]).optional(),

    lines: z.array(accrualRuleLineSchema).min(2),
      deferralSchedule: deferralScheduleSchema.optional()
  })
  .superRefine((v, ctx) => {
    // enforce balanced template for fixed-value rules
    let debit = 0n,
      credit = 0n;
    for (const [i, l] of v.lines.entries()) {
      const amt = parseDecimalToBigInt(l.amountValue || "0", 2);
      if (amt <= 0n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Line ${i + 1} amountValue must be > 0`,
          path: ["lines", i, "amountValue"],
        });
      }
      if (l.dc === "debit") debit += amt;
      else credit += amt;
    }
    if (debit !== credit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Accrual rule lines not balanced",
        path: ["lines"],
      });
    }
    // DEFERRAL strictness: must have schedule + exactly 2 lines + 1 debit/1 credit
  if (v.ruleType === "DEFERRAL") {
    if (!v.deferralSchedule) {
      ctx.addIssue({ code: "custom", message: "DEFERRAL rules require deferralSchedule" });
    }
    if (v.lines.length !== 2) {
      ctx.addIssue({ code: "custom", message: "DEFERRAL rules must have exactly 2 lines" });
    } else {
      const d = v.lines.filter((x) => x.dc === "debit").length;
      const c = v.lines.filter((x) => x.dc === "credit").length;
      if (d !== 1 || c !== 1) {
        ctx.addIssue({ code: "custom", message: "DEFERRAL rules must have 1 debit line and 1 credit line" });
      }
    }
  }

    // reversing constraints
    if (v.ruleType === "REVERSING") {
      if (v.autoReverse !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "REVERSING rules must have autoReverse=true",
          path: ["autoReverse"],
        });
      }
      if (v.reverseTiming && v.reverseTiming !== "NEXT_PERIOD_START") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid reverseTiming",
          path: ["reverseTiming"],
        });
      }
    }
  });

const runDueAccrualsSchema = z.object({
  asOfDate: isoDate,
});

const runPeriodEndAccrualsSchema = z.object({
  periodId: uuid,
  asOfDate: isoDate.optional(),
});


module.exports = {
  createAccrualRuleSchema,
  runDueAccrualsSchema,
  runPeriodEndAccrualsSchema,deferralScheduleSchema
};
