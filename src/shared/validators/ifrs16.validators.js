const { z } = require("zod");

const uuid = z.string().uuid();

// Params
const leaseIdParam = z.object({
  leaseId: uuid,
});

// Create lease (minimum viable for schedule + posting)
const createLease = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),

  commencement_date: z.coerce.date(),
  term_months: z.number().int().positive().max(600),
  payment_amount: z.number().positive(),
  payments_per_year: z.number().int().positive().max(12).default(12),
  annual_discount_rate: z.number().min(0).max(1),

  // Payment timing for schedule assumptions
  // - arrears: end-of-period payments (default)
  // - advance: beginning-of-period payments
  payment_timing: z.enum(["arrears", "advance"]).optional().default("arrears"),

  // Accounting mappings (GL accounts)
  rou_asset_account_id: uuid,
  lease_liability_account_id: uuid,
  interest_expense_account_id: uuid,
  depreciation_expense_account_id: uuid,
  accumulated_depreciation_account_id: uuid,
  cash_account_id: uuid,
});

const generateSchedule = z.object({
  leaseId: uuid,
  // If true, replaces any existing schedule lines.
  replace: z.boolean().optional().default(true),
});

const postLease = z.object({
  leaseId: uuid,
  // Post schedule lines due within this inclusive range
  from_date: z.coerce.date(),
  to_date: z.coerce.date(),

  // Posting options
  post_depreciation: z.boolean().optional().default(true),
  post_interest_and_payment: z.boolean().optional().default(true),
});

const postInitialRecognition = z.object({
  leaseId: uuid,
  // Optional override; defaults to lease commencement_date.
  entry_date: z.coerce.date().optional(),
  memo: z.string().max(500).optional(),
});

const updateStatus = z.object({
  leaseId: uuid,
  status: z.enum(["draft", "active", "terminated", "closed"]),
  reason: z.string().max(500).optional(),
  effective_date: z.coerce.date().optional(),
});

module.exports = {
  leaseIdParam,
  createLease,
  generateSchedule,
  postLease,
  postInitialRecognition,
  updateStatus,
};
