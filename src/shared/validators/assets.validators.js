const { z } = require("zod");

const uuid = z.string().uuid();
const isoDate = z.string().min(8); // YYYY-MM-DD

const createAssetCategorySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  assetAccountId: uuid,
  accumDeprAccountId: uuid,
  deprExpenseAccountId: uuid,
  // Required for operational completeness (disposal posting)
  disposalGainAccountId: uuid,
  disposalLossAccountId: uuid,
});

const createFixedAssetSchema = z.object({
  categoryId: uuid,
  code: z.string().min(1),
  name: z.string().min(1),
  acquisitionDate: isoDate,
  cost: z.number().nonnegative(),
  salvageValue: z.number().nonnegative().optional().default(0),
});

const acquireFixedAssetSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  fundingAccountId: uuid,
  memo: z.string().max(500).optional(),
});

const disposeFixedAssetSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  proceeds: z.number().nonnegative().default(0),
  proceedsAccountId: uuid,
  memo: z.string().max(500).optional(),
});

const createDepreciationScheduleSchema = z.object({
  assetId: uuid,
  method: z.enum(["straight_line"]).default("straight_line"),
  usefulLifeMonths: z.number().int().positive(),

  // Legacy field (keep for compatibility)
  depreciationStartDate: isoDate.optional(),

  // Option A fields (recommended)
  effectiveStartDate: isoDate.optional(),
  effectiveEndDate: isoDate.nullable().optional().default(null),
  componentCode: z.string().min(1).optional().nullable().default(null),
}).superRefine((val, ctx) => {
  if (!val.effectiveStartDate && !val.depreciationStartDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveStartDate"],
      message: "effectiveStartDate (or depreciationStartDate) is required",
    });
  }

  if (val.effectiveStartDate && val.effectiveEndDate && val.effectiveEndDate < val.effectiveStartDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveEndDate"],
      message: "effectiveEndDate must be >= effectiveStartDate",
    });
  }
});

const runDepreciationSchema = z.object({
  periodId: uuid,
});

module.exports = {
  createAssetCategorySchema,
  createFixedAssetSchema,
  acquireFixedAssetSchema,
  disposeFixedAssetSchema,
  createDepreciationScheduleSchema,
  runDepreciationSchema,
};
