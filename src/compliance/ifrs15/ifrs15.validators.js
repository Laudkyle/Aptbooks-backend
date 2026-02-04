const { z } = require("zod");

const uuid = z.string().uuid();

const contractIdParam = z.object({ contractId: uuid });

const upsertSettings = z.object({
  revenue_account_id: uuid,
  contract_asset_account_id: uuid,
  contract_liability_account_id: uuid,
  default_billing_account_id: uuid.optional(),
  // Alias for compatibility with clients that send billing_account_id
  billing_account_id: uuid.optional(),
  financing_interest_income_account_id: uuid.optional(),
  financing_interest_expense_account_id: uuid.optional(),
  default_cost_asset_account_id: uuid.optional(),
  default_cost_amort_expense_account_id: uuid.optional(),
  rounding_decimals: z.number().int().min(0).max(6).optional().default(2),
});

const createContract = z.object({
  code: z.string().min(1).max(50),
  // Core domain uses business_partners (type='customer').
  // Accept legacy customer_id for backward compatibility with earlier drafts.
  business_partner_id: uuid.optional(),
  customer_id: uuid.optional(),
  contract_date: z.coerce.date(),
  currency_code: z.string().min(3).max(10).optional(),
  transaction_price: z.number().min(0),
  billing_policy: z.enum(["UPFRONT", "AS_RECOGNIZED", "NONE"]).optional().default("UPFRONT"),
  billing_account_id: uuid.optional(),
  start_date: z.coerce.date().optional(),
  end_date: z.coerce.date().optional(),
});

const addObligation = z.object({
  contractId: uuid,
  description: z.string().min(1).max(500),
  obligation_type: z.enum(["POINT_IN_TIME", "OVER_TIME"]),
  satisfaction_method: z.enum(["TIME", "OUTPUT", "INPUT"]).optional().default("TIME"),
  standalone_selling_price: z.number().positive(),
  start_date: z.coerce.date().optional(),
  end_date: z.coerce.date().optional(),
  satisfaction_date: z.coerce.date().optional(),
});

const activateContract = z.object({
  contractId: uuid,
  memo: z.string().max(500).optional(),
  entry_date: z.coerce.date().optional(),
});

const generateSchedule = z.object({
  contractId: uuid,
  replace: z.boolean().optional().default(true),
});

const postRevenue = z.object({
  period_id: uuid,
  entry_date: z.coerce.date().optional(),
  memo: z.string().max(500).optional(),
});

// --------------------
// Stage 2: modifications
// --------------------

const createModification = z.object({
  contractId: uuid,
  modification_date: z.coerce.date(),
  modification_type: z.enum(["PRICE_CHANGE", "SCOPE_CHANGE", "SCOPE_AND_PRICE"]),
  new_base_transaction_price: z.number().nonnegative().optional(),
  // Decision-engine inputs (IFRS 15.20-21).
  adds_distinct_goods_services: z.boolean().optional(),
  price_increase_commensurate_with_ssp: z.boolean().optional(),
  remaining_goods_services_distinct: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

const modificationIdParam = z.object({ contractId: uuid, modificationId: uuid });

const applyModification = z.object({
  entry_date: z.coerce.date().optional(),
  memo: z.string().max(500).optional(),
  // Optional override for decision inputs at apply-time.
  adds_distinct_goods_services: z.boolean().optional(),
  price_increase_commensurate_with_ssp: z.boolean().optional(),
  remaining_goods_services_distinct: z.boolean().optional(),
});

// --------------------
// Stage 2B: variable consideration governance
// --------------------

const createVariableConsideration = z.object({
  contractId: uuid,
  effective_date: z.coerce.date(),
  method: z.enum(["EXPECTED_VALUE", "MOST_LIKELY"]),
  estimate_amount: z.number(),
  // Governance: management's assertion that it is "highly probable" a significant reversal will not occur.
  highly_probable_no_reversal: z.boolean().optional().default(false),
  constraint_basis: z.string().max(2000).optional(),
  rationale: z.string().max(2000).optional(),
});

const variableConsiderationIdParam = z.object({ contractId: uuid, variableConsiderationId: uuid });

const reviewVariableConsideration = z.object({
  notes: z.string().max(2000).optional(),
});

const approveVariableConsideration = z.object({
  // Only approvable if highly_probable_no_reversal is true (enforced in service).
  include_in_transaction_price: z.boolean().optional().default(false),
  included_amount: z.number().optional(),
  notes: z.string().max(2000).optional(),
});

const applyVariableConsideration = z.object({
  // Applies the latest approved VC entry as of the given effective date.
  effective_date: z.coerce.date().optional(),
});

// --------------------
// Stage 2: financing component
// --------------------

const setFinancingTerms = z.object({
  contractId: uuid,
  annual_rate: z.number().nonnegative(),
  effective_from: z.coerce.date(),
  effective_to: z.coerce.date().optional(),
});

const postFinancing = z.object({
  period_id: uuid,
  entry_date: z.coerce.date().optional(),
  memo: z.string().max(500).optional(),
});

// --------------------
// Stage 2: contract costs
// --------------------

const createCost = z.object({
  contractId: uuid,
  cost_type: z.enum(["ACQUISITION", "FULFILMENT"]),
  description: z.string().max(500).optional(),
  amount: z.number().positive(),
  asset_account_id: uuid.optional(),
  amort_expense_account_id: uuid.optional(),
  amort_start_date: z.coerce.date(),
  amort_end_date: z.coerce.date(),
});

const costIdParam = z.object({ contractId: uuid, costId: uuid });

const generateCostSchedule = z.object({
  contractId: uuid,
  costId: uuid,
  replace: z.boolean().optional().default(true),
});

const postCostAmort = z.object({
  period_id: uuid,
  entry_date: z.coerce.date().optional(),
  memo: z.string().max(500).optional(),
});

// --------------------
// Stage 2C: disclosures reports
// --------------------

const rollforwardReport = z.object({
  period_id: uuid,
});

const rpoReport = z.object({
  as_of_period_id: uuid,
});

const revenueDisaggregationReport = z.object({
  period_id: uuid,
  dimension: z.enum(["OBLIGATION_TYPE", "SATISFACTION_METHOD", "CUSTOMER"]).optional().default("OBLIGATION_TYPE"),
});

const judgementsReport = z.object({
  as_of_date: z.coerce.date().optional(),
});

module.exports = {
  contractIdParam,
  upsertSettings,
  createContract,
  addObligation,
  activateContract,
  generateSchedule,
  postRevenue,
  createModification,
  modificationIdParam,
  applyModification,
  createVariableConsideration,
  variableConsiderationIdParam,
  reviewVariableConsideration,
  approveVariableConsideration,
  applyVariableConsideration,
  setFinancingTerms,
  postFinancing,
  createCost,
  costIdParam,
  generateCostSchedule,
  postCostAmort,
  rollforwardReport,
  rpoReport,
  revenueDisaggregationReport,
  judgementsReport,
};
