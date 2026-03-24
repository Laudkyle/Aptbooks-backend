const { z } = require("zod");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createJurisdictionSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  countryCode: z.string().length(2).optional()
});

const updateJurisdictionSchema = createJurisdictionSchema.partial();

const createTaxCodeSchema = z.object({
  jurisdictionId: z.string().uuid().nullable().optional(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  taxType: z.enum(["VAT", "GST", "SALES"]),
  rate: z.coerce.number().min(0),
  isCompound: z.coerce.boolean().optional(),
  // Optional mapping used by VAT/tax return reporting.
  // boxCode is the return "box" identifier (e.g., "BOX_1").
  boxCode: z.string().min(1).max(50).optional().nullable(),
  // direction indicates whether the tax is output (sales) or input (purchases).
  direction: z.enum(["output", "input"]).optional().nullable(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.optional().nullable(),
  status: z.enum(["active", "inactive"]).optional()
}).superRefine((val, ctx) => {
  if (val.effectiveFrom && val.effectiveTo && val.effectiveTo < val.effectiveFrom) {
    ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "effectiveTo must be on or after effectiveFrom" });
  }
});

const updateTaxCodeSchema = createTaxCodeSchema.partial();


const createTaxAdjustmentSchema = z.object({
  adjustmentDate: isoDate,
  taxType: z.enum(["VAT", "GST", "SALES"]).default("VAT"),
  direction: z.enum(["output", "input"]),
  boxCode: z.string().min(1).max(50).optional().nullable(),
  description: z.string().min(2).max(500),
  amount: z.coerce.number().refine((v) => Number(v) !== 0, { message: "amount must not be zero" }),
  accountId: z.string().uuid().optional().nullable(),
  counterAccountId: z.string().uuid().optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
  autoPost: z.coerce.boolean().optional()
});

const voidTaxAdjustmentSchema = z.object({
  reason: z.string().min(2).max(500)
});

const setTaxSettingsSchema = z.object({
  outputTaxAccountId: z.string().uuid().nullable().optional(),
  inputTaxAccountId: z.string().uuid().nullable().optional(),
  defaultTaxCodeId: z.string().uuid().nullable().optional()
});

module.exports = {
  createJurisdictionSchema,
  updateJurisdictionSchema,
  createTaxCodeSchema,
  updateTaxCodeSchema,
  setTaxSettingsSchema,
  createTaxAdjustmentSchema,
  voidTaxAdjustmentSchema
};
