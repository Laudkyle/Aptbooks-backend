
const { z } = require("zod");
const uuid = z.string().uuid();
const dateOnly = z.coerce.date();
const decimalValue = z.union([z.number(), z.string().trim().regex(/^\d+(\.\d{1,6})?$/)]);
const nullableDecimal = z.union([decimalValue, z.null()]).optional();
const rateValue = z.union([z.number().min(0).max(1), z.string().trim().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/)]);
const commentPayload = z.object({ comment: z.string().max(1000).optional() });

const leaseIdParam = z.object({ leaseId: uuid });

const upsertSettings = z.object({
  default_term_months: z.coerce.number().int().positive().max(600).optional(),
  default_payments_per_year: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(12)]).optional(),
  default_annual_discount_rate: rateValue.optional(),
  default_payment_timing: z.enum(["arrears", "advance"]).optional(),
  rou_asset_account_id: uuid.nullish(),
  lease_liability_account_id: uuid.nullish(),
  interest_expense_account_id: uuid.nullish(),
  depreciation_expense_account_id: uuid.nullish(),
  accumulated_depreciation_account_id: uuid.nullish(),
  cash_account_id: uuid.nullish(),
  default_notes_template: z.string().max(5000).optional(),
});

const assetIdParam = z.object({ leaseId: uuid, assetId: uuid });
const modificationIdParam = z.object({ leaseId: uuid, modificationId: uuid });

const createLease = z.object({
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200),
  commencement_date: dateOnly,
  term_months: z.coerce.number().int().positive().max(600),
  payment_amount: decimalValue,
  payments_per_year: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(12)]).default(12),
  annual_discount_rate: rateValue,
  payment_timing: z.enum(["arrears", "advance"]).optional().default("arrears"),
  recognition_model: z.enum(["on_balance_sheet","short_term_exempt","low_value_exempt"]).optional(),
  is_short_term_lease: z.boolean().optional(),
  is_low_value_lease: z.boolean().optional(),
  practical_expedient_non_lease_components: z.boolean().optional(),
  ownership_transfers: z.boolean().optional(),
  purchase_option_reasonably_certain: z.boolean().optional(),
  rou_asset_account_id: uuid.optional(),
  lease_liability_account_id: uuid.optional(),
  interest_expense_account_id: uuid.optional(),
  depreciation_expense_account_id: uuid.optional(),
  accumulated_depreciation_account_id: uuid.optional(),
  cash_account_id: uuid.optional(),
  contract_reference: z.string().max(200).optional(),
  currency_code: z.string().length(3).optional(),
  asset_code: z.string().max(100).optional(),
  asset_description: z.string().max(250).optional(),
  asset_class: z.string().max(100).optional(),
  useful_life_months: z.coerce.number().int().positive().max(1200).optional(),
  initial_direct_costs: nullableDecimal,
  lease_incentives: nullableDecimal,
  restoration_provision: nullableDecimal,
  prepaid_lease_payments: nullableDecimal,
  accrued_lease_payments: nullableDecimal,
  residual_value_guarantee: nullableDecimal,
  purchase_option_amount: nullableDecimal,
  has_purchase_option: z.boolean().optional(),
  has_extension_option: z.boolean().optional(),
  has_termination_option: z.boolean().optional(),
  indexation: z.string().max(100).optional(),
});

const upsertContract = z.object({
  counterparty_partner_id: uuid.optional(),
  contract_reference: z.string().max(200).optional(),
  currency_code: z.string().length(3).optional(),
  payment_timing: z.enum(["arrears", "advance"]).optional(),
  indexation: z.string().max(100).optional(),
  has_purchase_option: z.boolean().optional(),
  has_extension_option: z.boolean().optional(),
  has_termination_option: z.boolean().optional(),
  residual_value_guarantee: nullableDecimal,
  initial_direct_costs: nullableDecimal,
  lease_incentives: nullableDecimal,
  restoration_provision: nullableDecimal,
  prepaid_lease_payments: nullableDecimal,
  accrued_lease_payments: nullableDecimal,
  purchase_option_amount: nullableDecimal,
});

const createAsset = z.object({
  asset_code: z.string().max(100).optional(),
  description: z.string().min(1).max(250),
  asset_class: z.string().max(100).optional(),
  useful_life_months: z.coerce.number().int().positive().max(1200).optional(),
  rou_cost: nullableDecimal,
  is_primary: z.boolean().optional(),
});
const updateAsset = createAsset.partial();

const createPayment = z.object({
  due_date: dateOnly,
  amount: decimalValue,
  payment_type: z.enum(["fixed","variable","fee","incentive","restoration","other"]).optional(),
  is_actual: z.boolean().optional(),
  paid_date: dateOnly.optional(),
  reference: z.string().max(100).optional(),
  schedule_line_id: uuid.optional(),
});

const generateSchedule = z.object({ leaseId: uuid, replace: z.boolean().optional().default(true) });
const postLease = z.object({ leaseId: uuid, from_date: dateOnly, to_date: dateOnly, post_depreciation: z.boolean().optional().default(true), post_interest_and_payment: z.boolean().optional().default(true) });
const postInitialRecognition = z.object({ leaseId: uuid, entry_date: dateOnly.optional(), memo: z.string().max(500).optional() });
const updateStatus = z.object({ leaseId: uuid, status: z.enum(["draft", "active", "terminated", "closed"]), reason: z.string().max(500).optional(), effective_date: dateOnly.optional() });

const createModification = z.object({
  effective_date: dateOnly,
  reason: z.string().max(1000).optional(),
  new_term_months: z.coerce.number().int().positive().max(600).optional(),
  new_payment_amount: decimalValue.optional(),
  new_payments_per_year: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(12)]).optional(),
  new_annual_discount_rate: rateValue.optional(),
  new_payment_timing: z.enum(["arrears","advance"]).optional(),
}).refine((v) => v.new_term_months || v.new_payment_amount || v.new_payments_per_year || v.new_annual_discount_rate !== undefined || v.new_payment_timing, { message: 'At least one modification change is required' });


const updateLease = createLease.partial().refine((v) => Object.keys(v).length > 0, { message: 'At least one lease field is required' });
const updatePayment = createPayment.partial().refine((v) => Object.keys(v).length > 0, { message: 'At least one payment field is required' });
const paymentIdParam = z.object({ leaseId: uuid, paymentId: uuid });
const updateModification = createModification.partial().refine((v) => Object.keys(v).length > 0, { message: 'At least one modification field is required' });

const reportQuery = z.object({
  as_of_date: dateOnly.optional(),
  from_date: dateOnly.optional(),
  to_date: dateOnly.optional(),
  period_id: uuid.optional(),
  currency_code: z.string().length(3).optional(),
  asset_class: z.string().max(100).optional(),
  status: z.enum(['draft','active','terminated','closed']).optional(),
  recognition_model: z.enum(['on_balance_sheet','short_term_exempt','low_value_exempt']).optional(),
  limit: z.coerce.number().int().positive().max(500).optional()
});

module.exports = {
  leaseIdParam, assetIdParam, modificationIdParam, paymentIdParam, upsertSettings, createLease, updateLease, upsertContract, createAsset, updateAsset, createPayment, updatePayment,
  generateSchedule, postLease, postInitialRecognition, updateStatus, createModification, updateModification, commentPayload, reportQuery,
};
