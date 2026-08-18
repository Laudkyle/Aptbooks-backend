const { z } = require("zod");
const { moneyAmount, positiveMoneyAmount } = require("./financial.validators");
const uuid = z.string().uuid();
const isoDate = z.string().min(8); // YYYY-MM-DD

const createAssetCategorySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  assetAccountId: uuid,
  accumDeprAccountId: uuid,
  deprExpenseAccountId: uuid,
  disposalGainAccountId: uuid,
  disposalLossAccountId: uuid,
});

const updateAssetCategorySchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  assetAccountId: uuid.optional(),
  accumDeprAccountId: uuid.optional(),
  deprExpenseAccountId: uuid.optional(),
  disposalGainAccountId: uuid.optional(),
  disposalLossAccountId: uuid.optional(),
  status: z.enum(["active","inactive"]).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });

const createFixedAssetSchema = z.object({
  categoryId: uuid,
  code: z.string().min(1),
  name: z.string().min(1),
  acquisitionDate: isoDate,
  cost: moneyAmount,
  salvageValue: moneyAmount.optional().default("0"),
  locationId: uuid.optional().nullable().default(null),
  departmentId: uuid.optional().nullable().default(null),
  costCenterId: uuid.optional().nullable().default(null),
});

const updateFixedAssetSchema = z.object({
  categoryId: uuid.optional(),
  code: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  acquisitionDate: isoDate.optional(),
  cost: moneyAmount.optional(),
  salvageValue: moneyAmount.optional(),
  locationId: uuid.optional().nullable(),
  departmentId: uuid.optional().nullable(),
  costCenterId: uuid.optional().nullable(),
  status: z.enum(["draft","active","retired","disposed"]).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });

const acquireFixedAssetSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  fundingAccountId: uuid,
  memo: z.string().max(500).optional(),
});

const disposeFixedAssetSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  proceeds: moneyAmount.default("0"),
  proceedsAccountId: uuid,
  memo: z.string().max(500).optional(),
});

const assetTransferSchema = z.object({
  eventDate: isoDate,
  toLocationId: uuid.optional().nullable().default(null),
  toDepartmentId: uuid.optional().nullable().default(null),
  toCostCenterId: uuid.optional().nullable().default(null),
  reference: z.string().max(120).optional().nullable().default(null),
  memo: z.string().max(500).optional().nullable().default(null),
});

const assetRevaluationSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  newValue: moneyAmount,
  revaluationReserveAccountId: uuid,
  memo: z.string().max(500).optional(),
});

const assetImpairmentSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  impairmentAmount: positiveMoneyAmount,
  impairmentLossAccountId: uuid,
  memo: z.string().max(500).optional(),
});

const createDepreciationScheduleSchema = z.object({
  assetId: uuid,
  method: z.enum(["straight_line"]).default("straight_line"),
  usefulLifeMonths: z.number().int().positive(),
  depreciationStartDate: isoDate.optional(),
  effectiveStartDate: isoDate.optional(),
  effectiveEndDate: isoDate.nullable().optional().default(null),
  componentCode: z.string().min(1).optional().nullable().default(null),
}).superRefine((val, ctx) => {
  if (!val.effectiveStartDate && !val.depreciationStartDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveStartDate"], message: "effectiveStartDate (or depreciationStartDate) is required" });
  }
  if (val.effectiveStartDate && val.effectiveEndDate && val.effectiveEndDate < val.effectiveStartDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveEndDate"], message: "effectiveEndDate must be >= effectiveStartDate" });
  }
});

const updateDepreciationScheduleSchema = z.object({
  method: z.enum(["straight_line"]).optional(),
  usefulLifeMonths: z.number().int().positive().optional(),
  effectiveStartDate: isoDate.optional(),
  effectiveEndDate: isoDate.nullable().optional(),
  status: z.enum(["active","inactive","complete"]).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });

const runDepreciationSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  memo: z.string().max(500).optional(),
});

module.exports = {
  createAssetCategorySchema,
  updateAssetCategorySchema,
  createFixedAssetSchema,
  updateFixedAssetSchema,
  acquireFixedAssetSchema,
  disposeFixedAssetSchema,
  assetTransferSchema,
  assetRevaluationSchema,
  assetImpairmentSchema,
  createDepreciationScheduleSchema,
  updateDepreciationScheduleSchema,
  runDepreciationSchema,
};
