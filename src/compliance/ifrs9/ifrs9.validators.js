const { z } = require("zod");

const coerceNumber = (schema = z.number()) => z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
  schema
);

const coerceNullableNumber = (schema = z.number().nullable()) => z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
  schema
);

const coerceInt = (schema = z.number().int()) => z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
  schema
);

const nullableIntSchema = z.number().int().nullable();

const upsertSettingsSchema = z.object({
  impairment_expense_account_id: z.string().uuid().optional(),
  impairmentExpenseAccountId: z.string().uuid().optional(),
  loss_allowance_account_id: z.string().uuid().optional(),
  allowance_account_id: z.string().uuid().optional(),
  allowanceAccountId: z.string().uuid().optional(),
  default_model_id: z.string().uuid().nullable().optional(),
  defaultModelId: z.string().uuid().nullable().optional(),
  rounding_decimals: coerceInt(z.number().int().min(0).max(6)).optional(),
  roundingDecimals: coerceInt(z.number().int().min(0).max(6)).optional(),
  stage2_threshold_days: coerceInt(z.number().int().min(0).max(3650)).optional(),
  stage2_days_past_due: coerceInt(z.number().int().min(0).max(3650)).optional(),
  stage2DaysPastDue: coerceInt(z.number().int().min(0).max(3650)).optional(),
  stage3_threshold_days: coerceInt(z.number().int().min(0).max(3650)).optional(),
  stage3_days_past_due: coerceInt(z.number().int().min(0).max(3650)).optional(),
  stage3DaysPastDue: coerceInt(z.number().int().min(0).max(3650)).optional(),
  default_lgd: coerceNumber(z.number().min(0).max(1)).optional(),
  defaultLgd: coerceNumber(z.number().min(0).max(1)).optional(),
  annual_discount_rate: coerceNumber(z.number().min(0).max(1)).optional(),
  annualDiscountRate: coerceNumber(z.number().min(0).max(1)).optional(),
  model_change_approval_required: z.coerce.boolean().optional(),
  modelChangeApprovalRequired: z.coerce.boolean().optional()
});

const createModelSchema = z.object({
  code: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  model_type: z.enum(["SIMPLIFIED", "GENERAL"]).optional(),
  method: z.enum(["SIMPLIFIED", "GENERAL", "simplified", "general"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  config_json: z.record(z.any()).optional(),
  configJson: z.record(z.any()).optional()
});

const addBucketSchema = z.object({
  label: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(64).optional(),
  days_past_due_from: coerceInt(z.number().int().min(0)),
  days_past_due_to: coerceNullableNumber(nullableIntSchema).optional(),
  loss_rate: coerceNumber(z.number().min(0).max(1))
});

const computeEclSchema = z.object({
  period_id: z.string().uuid(),
  model_id: z.string().uuid().optional(),
  approach: z.enum(["SIMPLIFIED", "GENERAL"]).optional(),
  as_of_date: z.string().optional(),
  memo: z.string().max(500).optional(),
  scenario_ids: z.array(z.string().uuid()).optional(),
  use_behavioral_metrics: z.coerce.boolean().optional(),
  behavioral_snapshot_id: z.string().uuid().optional()
});

const upsertCounterpartyProfileSchema = z.object({
  business_partner_id: z.string().uuid(),
  segment: z.string().max(255).optional(),
  stage_override: coerceNullableNumber(nullableIntSchema.refine((v) => v === null || [1, 2, 3].includes(v), "stage_override must be 1, 2 or 3")).optional(),
  override_reason: z.string().max(500).optional(),
  status: z.enum(["active", "inactive"]).optional()
});

const addParameterSchema = z.object({
  stage: coerceInt(z.number().int().min(1).max(3)),
  label: z.string().min(1).max(64),
  days_past_due_from: coerceInt(z.number().int().min(0)),
  days_past_due_to: coerceNullableNumber(nullableIntSchema).optional(),
  pd_12m: coerceNumber(z.number().min(0).max(1)),
  pd_lifetime: coerceNumber(z.number().min(0).max(1)),
  lgd: coerceNullableNumber(z.number().min(0).max(1).nullable()).optional()
});

const postEclSchema = z.object({
  run_id: z.string().uuid(),
  period_id: z.string().uuid(),
  entry_date: z.string().optional(),
  posting_date: z.string().optional(),
  memo: z.string().max(500).optional()
});

const reverseEclSchema = z.object({
  run_id: z.string().uuid(),
  target_period_id: z.string().uuid(),
  entry_date: z.string(),
  reason: z.string().min(1).max(500)
});


const createScenarioSchema = z.object({
  code: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  scenario_type: z.enum(["BASE", "UPSIDE", "DOWNSIDE", "CUSTOM"]).optional(),
  probability_weight: coerceNumber(z.number().min(0).max(1)).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  effective_from: z.string().optional(),
  effective_to: z.string().optional(),
  variable_set: z.record(z.any()).optional()
});

const upsertScenarioOverlaySchema = z.object({
  model_id: z.string().uuid().nullable().optional(),
  segment: z.string().max(255).optional(),
  stage: coerceNullableNumber(nullableIntSchema.refine((v) => v === null || [1, 2, 3].includes(v), "stage must be 1, 2 or 3")).optional(),
  days_past_due_from: coerceNullableNumber(nullableIntSchema).optional(),
  days_past_due_to: coerceNullableNumber(nullableIntSchema).optional(),
  pd_multiplier: coerceNumber(z.number().min(0)).optional(),
  lgd_multiplier: coerceNumber(z.number().min(0)).optional(),
  loss_rate_multiplier: coerceNumber(z.number().min(0)).optional(),
  ecl_multiplier: coerceNumber(z.number().min(0)).optional(),
  notes: z.string().max(1000).optional()
});

const upsertSicrTriggerSchema = z.object({
  business_partner_id: z.string().uuid().optional(),
  segment: z.string().max(255).optional(),
  trigger_code: z.string().min(1).max(64),
  trigger_name: z.string().min(1).max(255),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  force_stage_min: coerceNullableNumber(nullableIntSchema.refine((v) => v === null || [1, 2, 3].includes(v), "force_stage_min must be 1, 2 or 3")).optional(),
  pd_multiplier: coerceNumber(z.number().min(0)).optional(),
  lgd_multiplier: coerceNumber(z.number().min(0)).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  valid_from: z.string().optional(),
  valid_to: z.string().optional(),
  source: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
  metadata: z.record(z.any()).optional()
});

const behavioralAnalyticsSchema = z.object({
  as_of_date: z.string(),
  horizon_months: coerceInt(z.number().int().min(1).max(120)).optional(),
  transition_window_days: coerceInt(z.number().int().min(1).max(365)).optional(),
  persist_snapshot: z.coerce.boolean().optional()
});

const createModelChangeRequestSchema = z.object({
  model_id: z.string().uuid().optional(),
  change_type: z.enum(["SETTINGS_UPSERT", "MODEL_CREATE", "BUCKET_ADD", "PARAMETER_ADD", "SCENARIO_CREATE", "SCENARIO_OVERLAY_UPSERT", "SICR_TRIGGER_UPSERT"]),
  title: z.string().min(1).max(255),
  reason: z.string().max(2000).optional(),
  payload: z.record(z.any())
});

const approvalCommentSchema = z.object({
  comment: z.string().max(1000).optional()
});

module.exports = {
  upsertSettingsSchema,
  createModelSchema,
  addBucketSchema,
  upsertCounterpartyProfileSchema,
  addParameterSchema,
  computeEclSchema,
  postEclSchema,
  reverseEclSchema,
  createScenarioSchema,
  upsertScenarioOverlaySchema,
  upsertSicrTriggerSchema,
  behavioralAnalyticsSchema,
  createModelChangeRequestSchema,
  approvalCommentSchema
};
