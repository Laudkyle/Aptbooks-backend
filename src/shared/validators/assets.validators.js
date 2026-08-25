const { z } = require("zod");
const { moneyAmount, positiveMoneyAmount } = require("./financial.validators");

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((value) => {
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const optionalText = (max) => z.string().trim().max(max).optional().nullable();
const depreciationMethod = z.enum(["straight_line", "reducing_balance"]);
const depreciationConvention = z.enum(["full_month", "daily_prorata"]);
const percent = z.coerce.number().positive().max(100);

const categoryDefaults = {
  defaultDepreciationMethod: depreciationMethod.optional().default("straight_line"),
  defaultUsefulLifeMonths: z.coerce.number().int().positive().max(1200).optional().nullable(),
  defaultDepreciationConvention: depreciationConvention.optional().default("full_month"),
  defaultDecliningRatePercent: percent.optional().nullable(),
};

const createAssetCategorySchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  assetAccountId: uuid,
  accumDeprAccountId: uuid,
  deprExpenseAccountId: uuid,
  disposalGainAccountId: uuid,
  disposalLossAccountId: uuid,
  ...categoryDefaults,
}).superRefine((value, ctx) => {
  if (value.defaultDepreciationMethod === "reducing_balance" && !value.defaultDecliningRatePercent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultDecliningRatePercent"], message: "Rate is required for reducing-balance depreciation" });
  }
});

const updateAssetCategorySchema = z.object({
  code: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  assetAccountId: uuid.optional(),
  accumDeprAccountId: uuid.optional(),
  deprExpenseAccountId: uuid.optional(),
  disposalGainAccountId: uuid.optional(),
  disposalLossAccountId: uuid.optional(),
  defaultDepreciationMethod: depreciationMethod.optional(),
  defaultUsefulLifeMonths: z.coerce.number().int().positive().max(1200).optional().nullable(),
  defaultDepreciationConvention: depreciationConvention.optional(),
  defaultDecliningRatePercent: percent.optional().nullable(),
  status: z.enum(["active", "inactive"]).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });

const createFixedAssetSchema = z.object({
  categoryId: uuid,
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  acquisitionDate: isoDate,
  inServiceDate: isoDate.optional().nullable(),
  cost: positiveMoneyAmount,
  salvageValue: moneyAmount.optional().default("0"),
  locationId: uuid.optional().nullable().default(null),
  departmentId: uuid.optional().nullable().default(null),
  costCenterId: uuid.optional().nullable().default(null),
  assetTag: optionalText(100),
  serialNumber: optionalText(120),
  manufacturer: optionalText(160),
  model: optionalText(160),
}).superRefine((value, ctx) => {
  if (value.inServiceDate && value.inServiceDate < value.acquisitionDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["inServiceDate"], message: "In-service date cannot be before acquisition date" });
  }
});

const updateFixedAssetSchema = z.object({
  categoryId: uuid.optional(),
  code: z.string().trim().min(1).max(60).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  acquisitionDate: isoDate.optional(),
  inServiceDate: isoDate.optional().nullable(),
  cost: positiveMoneyAmount.optional(),
  salvageValue: moneyAmount.optional(),
  locationId: uuid.optional().nullable(),
  departmentId: uuid.optional().nullable(),
  costCenterId: uuid.optional().nullable(),
  assetTag: optionalText(100),
  serialNumber: optionalText(120),
  manufacturer: optionalText(160),
  model: optionalText(160),
  status: z.enum(["draft", "active", "retired", "disposed"]).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });

const acquireFixedAssetSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  fundingAccountId: uuid,
  memo: z.string().trim().max(500).optional(),
});

const disposeFixedAssetSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  proceeds: moneyAmount.default("0"),
  proceedsAccountId: uuid,
  memo: z.string().trim().max(500).optional(),
});

const retireFixedAssetSchema = z.object({
  eventDate: isoDate,
  reason: z.string().trim().min(3).max(500),
});

const assetTransferSchema = z.object({
  eventDate: isoDate,
  toLocationId: uuid.optional().nullable().default(null),
  toDepartmentId: uuid.optional().nullable().default(null),
  toCostCenterId: uuid.optional().nullable().default(null),
  reference: optionalText(120).default(null),
  memo: optionalText(500).default(null),
});

const assetRevaluationSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  newValue: positiveMoneyAmount,
  revaluationReserveAccountId: uuid,
  memo: z.string().trim().max(500).optional(),
});

const assetImpairmentSchema = z.object({
  periodId: uuid,
  entryDate: isoDate,
  impairmentAmount: positiveMoneyAmount,
  impairmentLossAccountId: uuid,
  memo: z.string().trim().max(500).optional(),
});

const createDepreciationScheduleSchema = z.object({
  assetId: uuid,
  method: depreciationMethod.optional(),
  usefulLifeMonths: z.coerce.number().int().positive().max(1200).optional(),
  depreciationStartDate: isoDate.optional(),
  effectiveStartDate: isoDate.optional(),
  effectiveEndDate: isoDate.nullable().optional().default(null),
  componentCode: z.string().trim().min(1).max(80).optional().nullable().default(null),
  basisAmount: positiveMoneyAmount.optional(),
  residualValue: moneyAmount.optional(),
  depreciationConvention: depreciationConvention.optional(),
  decliningRatePercent: percent.optional().nullable(),
}).superRefine((value, ctx) => {
  const start = value.effectiveStartDate || value.depreciationStartDate;
  if (!start) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveStartDate"], message: "Effective start date is required" });
  if (start && value.effectiveEndDate && value.effectiveEndDate < start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveEndDate"], message: "Effective end date must be on or after start date" });
  }
  if (value.method === "reducing_balance" && !value.decliningRatePercent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decliningRatePercent"], message: "Rate is required for reducing-balance depreciation" });
  }
});

const updateDepreciationScheduleSchema = z.object({
  method: depreciationMethod.optional(),
  usefulLifeMonths: z.coerce.number().int().positive().max(1200).optional(),
  effectiveStartDate: isoDate.optional(),
  effectiveEndDate: isoDate.nullable().optional(),
  componentCode: z.string().trim().min(1).max(80).optional().nullable(),
  basisAmount: positiveMoneyAmount.optional(),
  residualValue: moneyAmount.optional(),
  depreciationConvention: depreciationConvention.optional(),
  decliningRatePercent: percent.optional().nullable(),
  status: z.enum(["active", "inactive", "complete"]).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });

const runDepreciationSchema = z.object({
  periodId: uuid,
  entryDate: isoDate.optional(),
  memo: z.string().trim().max(500).optional(),
});

const createAssetDimensionSchema = z.object({
  type: z.enum(["location", "department"]),
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
});

module.exports = {
  createAssetCategorySchema, updateAssetCategorySchema, createFixedAssetSchema, updateFixedAssetSchema,
  acquireFixedAssetSchema, disposeFixedAssetSchema, retireFixedAssetSchema, assetTransferSchema,
  assetRevaluationSchema, assetImpairmentSchema, createDepreciationScheduleSchema,
  updateDepreciationScheduleSchema, runDepreciationSchema, createAssetDimensionSchema,
};
