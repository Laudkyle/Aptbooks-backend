const { z } = require("zod"); 

// --------------------------------------
// Settings
// --------------------------------------

const upsertSettingsSchema = z.object({
  impairment_expense_account_id: z.string().uuid().optional(),
  loss_allowance_account_id: z.string().uuid().optional(),
  default_model_id: z.string().uuid().nullable().optional(),
  rounding_decimals: z.number().int().min(0).max(6).optional(),

  // Stage 2 (general approach) defaults / thresholds
  stage2_threshold_days: z.number().int().min(0).max(3650).optional(),
  stage3_threshold_days: z.number().int().min(0).max(3650).optional(),
  default_lgd: z.number().min(0).max(1).optional(),
  annual_discount_rate: z.number().min(0).max(1).optional()
}); 

// --------------------------------------
// ECL models and buckets
// --------------------------------------

const createModelSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  model_type: z.enum(["SIMPLIFIED", "GENERAL"]).optional(),
  status: z.enum(["active", "inactive"]).optional()
}); 

const addBucketSchema = z.object({
  label: z.string().min(1).max(64),
  days_past_due_from: z.number().int().min(0),
  days_past_due_to: z.number().int().min(0).nullable().optional(),
  loss_rate: z.number().min(0).max(1)
}); 

// --------------------------------------
// Runs
// --------------------------------------

const computeEclSchema = z.object({
  period_id: z.string().uuid(),
  model_id: z.string().uuid().optional(),
  approach: z.enum(["SIMPLIFIED", "GENERAL"]).optional(),
  as_of_date: z.string().optional(),
  memo: z.string().max(500).optional()
}); 

// Stage 2: Counterparty profile
const upsertCounterpartyProfileSchema = z.object({
  business_partner_id: z.string().uuid(),
  segment: z.string().max(255).optional(),
  stage_override: z.number().int().min(1).max(3).nullable().optional(),
  override_reason: z.string().max(500).optional(),
  status: z.enum(["active", "inactive"]).optional()
}); 

// Stage 2: PD/LGD parameter lines
const addParameterSchema = z.object({
  stage: z.number().int().min(1).max(3),
  label: z.string().min(1).max(64),
  days_past_due_from: z.number().int().min(0),
  days_past_due_to: z.number().int().min(0).nullable().optional(),
  pd_12m: z.number().min(0).max(1),
  pd_lifetime: z.number().min(0).max(1),
  lgd: z.number().min(0).max(1).nullable().optional()
}); 

const postEclSchema = z.object({
  run_id: z.string().uuid(),
  period_id: z.string().uuid(),
  entry_date: z.string().optional(),
  memo: z.string().max(500).optional()
}); 

const reverseEclSchema = z.object({
  run_id: z.string().uuid(),
  target_period_id: z.string().uuid(),
  entry_date: z.string(),
  reason: z.string().min(1).max(500)
}); 

module.exports = {
  upsertSettingsSchema,
  createModelSchema,
  addBucketSchema,
  upsertCounterpartyProfileSchema,
  addParameterSchema,
  computeEclSchema,
  postEclSchema,
  reverseEclSchema
}; 
