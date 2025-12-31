const { z } = require("zod");

const uuid = z.string().uuid();

const createAssetCategorySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  assetAccountId: uuid,
  accumDeprAccountId: uuid,
  deprExpenseAccountId: uuid,
});

const createFixedAssetSchema = z.object({
  categoryId: uuid,
  code: z.string().min(1),
  name: z.string().min(1),
  acquisitionDate: z.string().min(8), // YYYY-MM-DD (your validate() likely enforces)
  cost: z.number().nonnegative(),
  salvageValue: z.number().nonnegative().optional().default(0),
});

const createDepreciationScheduleSchema = z.object({
  assetId: uuid,
  method: z.enum(["straight_line"]).default("straight_line"),
  usefulLifeMonths: z.number().int().positive(),

  // Legacy field (keep for compatibility)
  depreciationStartDate: z.string().min(8).optional(),

  // Option A fields (recommended)
  effectiveStartDate: z.string().min(8).optional(),
  effectiveEndDate: z.string().min(8).nullable().optional().default(null),
  componentCode: z.string().min(1).optional().nullable().default(null),
}).superRefine((val, ctx) => {
  // Require at least one date source
  if (!val.effectiveStartDate && !val.depreciationStartDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveStartDate"],
      message: "effectiveStartDate (or depreciationStartDate) is required",
    });
  }

  // If both present, enforce consistency (optional but recommended)
  // You can relax this, but it prevents subtle errors.
  if (val.effectiveStartDate && val.effectiveEndDate && val.effectiveEndDate < val.effectiveStartDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveEndDate"],
      message: "effectiveEndDate must be >= effectiveStartDate",
    });
  }
});

const runDepreciationSchema = z.object({
  periodId: uuid
});

module.exports = {
  createAssetCategorySchema,
  createFixedAssetSchema,
  createDepreciationScheduleSchema,
  runDepreciationSchema
};
