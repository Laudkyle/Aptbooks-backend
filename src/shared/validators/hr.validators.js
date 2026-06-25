const { z } = require("zod");

const uuid = z.string().uuid();

// -----------------------------------------------------------------------------
// Departments
// -----------------------------------------------------------------------------
const createDepartmentSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
});

const updateDepartmentSchema = z.object({
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

// -----------------------------------------------------------------------------
// Grades
// -----------------------------------------------------------------------------
const createGradeSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  currency: z.string().min(1).max(10).default("GHS"),
  min_amount: z.number().nonnegative().optional(),
  max_amount: z.number().nonnegative().optional(),
}).refine((v) => {
  if (v.min_amount == null || v.max_amount == null) return true;
  return v.max_amount >= v.min_amount;
}, { message: "max_amount must be >= min_amount" });

const updateGradeSchema = z.object({
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200).optional(),
  currency: z.string().min(1).max(10).optional(),
  min_amount: z.number().nonnegative().optional(),
  max_amount: z.number().nonnegative().optional(),
  status: z.enum(["active", "inactive"]).optional(),
}).refine((v) => {
  if (v.min_amount == null || v.max_amount == null) return true;
  return v.max_amount >= v.min_amount;
}, { message: "max_amount must be >= min_amount" });

// -----------------------------------------------------------------------------
// Positions
// -----------------------------------------------------------------------------
const createPositionSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  department_id: uuid.optional().nullable(),
  grade_id: uuid.optional().nullable(),
});

const updatePositionSchema = z.object({
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200).optional(),
  department_id: uuid.optional().nullable(),
  grade_id: uuid.optional().nullable(),
  status: z.enum(["active", "inactive"]).optional(),
});

// -----------------------------------------------------------------------------
// Compensation Bands (no payroll computation in Stage 1)
// -----------------------------------------------------------------------------
const createCompBandSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  currency: z.string().min(1).max(10).default("GHS"),
  min_amount: z.number().nonnegative(),
  max_amount: z.number().nonnegative(),
  pay_frequency: z.enum(["monthly", "weekly", "daily"]).default("monthly"),
}).refine((v) => v.max_amount >= v.min_amount, { message: "max_amount must be >= min_amount" });

const updateCompBandSchema = z.object({
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200).optional(),
  currency: z.string().min(1).max(10).optional(),
  min_amount: z.number().nonnegative().optional(),
  max_amount: z.number().nonnegative().optional(),
  pay_frequency: z.enum(["monthly", "weekly", "daily"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
}).refine((v) => {
  if (v.min_amount == null || v.max_amount == null) return true;
  return v.max_amount >= v.min_amount;
}, { message: "max_amount must be >= min_amount" });

// -----------------------------------------------------------------------------
// Employees
// -----------------------------------------------------------------------------
const createEmployeeSchema = z.object({
  employee_no: z.string().min(1).max(50),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  other_names: z.string().max(200).optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  hire_date: z.string().min(4).optional().nullable(),
  status: z.enum(["draft", "active", "inactive", "terminated"]).default("draft"),

  department_id: uuid.optional().nullable(),
  position_id: uuid.optional().nullable(),
  grade_id: uuid.optional().nullable(),
  cost_center_id: uuid.optional().nullable(),

  expense_account_id: uuid.optional().nullable(),
  payable_account_id: uuid.optional().nullable(),

  compensation_band_id: uuid.optional().nullable(),
  base_salary_amount: z.number().nonnegative().optional().nullable(),
  base_salary_currency: z.string().min(1).max(10).optional().nullable(),
  base_salary_frequency: z.enum(["monthly", "weekly", "daily"]).optional().nullable(),

  bank_name: z.string().max(120).optional().nullable(),
  bank_account_no: z.string().max(80).optional().nullable(),
  bank_branch: z.string().max(120).optional().nullable(),

  tax_id: z.string().max(80).optional().nullable(),
  national_id: z.string().max(80).optional().nullable(),
});

const updateEmployeeSchema = createEmployeeSchema.partial().extend({
  employee_no: z.string().min(1).max(50).optional(),
});



// -----------------------------------------------------------------------------
// Leave Management
// -----------------------------------------------------------------------------
const createLeaveTypeSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  unit: z.enum(["days"]).optional(),
  is_paid: z.boolean().optional(),
});

const updateLeaveTypeSchema = z.object({
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200).optional(),
  unit: z.enum(["days"]).optional(),
  is_paid: z.boolean().optional(),
  status: z.enum(["active","inactive"]).optional(),
});

const upsertLeaveBalanceSchema = z.object({
  employee_id: uuid,
  leave_type_id: uuid,
  balance_days: z.number().finite(),
  reason: z.string().max(500).optional(),
});

const createLeaveRequestSchema = z.object({
  employee_id: uuid,
  leave_type_id: uuid,
  start_date: z.string().min(8),
  end_date: z.string().min(8),
  days: z.number().positive(),
  reason: z.string().max(2000).optional(),
});

const updateLeaveRequestSchema = z.object({
  employee_id: uuid.optional(),
  leave_type_id: uuid.optional(),
  start_date: z.string().min(8).optional(),
  end_date: z.string().min(8).optional(),
  days: z.number().positive().optional(),
  reason: z.string().max(2000).nullable().optional(),
});

const rejectLeaveRequestSchema = z.object({
  reason: z.string().max(2000).optional(),
});

// -----------------------------------------------------------------------------
// Benefits
// -----------------------------------------------------------------------------
const createBenefitPlanSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  // Accept percentage (e.g., 13.0) or fraction (0.13)
  employer_rate: z.number().min(0).max(100),
  employee_rate: z.number().min(0).max(100),
  base_on: z.enum(["base", "gross"]).default("base").optional(),
  cap_amount: z.number().positive().optional().nullable(),
  expense_account_id: uuid,
  liability_account_id: uuid,
});

const updateBenefitPlanSchema = z.object({
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  employer_rate: z.number().min(0).max(100).optional(),
  employee_rate: z.number().min(0).max(100).optional(),
  base_on: z.enum(["base", "gross"]).optional(),
  cap_amount: z.number().positive().nullable().optional(),
  expense_account_id: uuid.optional(),
  liability_account_id: uuid.optional(),
  status: z.enum(["active","inactive"]).optional(),
});

const assignEmployeeBenefitSchema = z.object({
  employee_id: uuid,
  benefit_plan_id: uuid,
  effective_from: z.string().min(8),
  effective_to: z.string().min(8).optional(),
});

const updateEmployeeBenefitSchema = z.object({
  effective_from: z.string().min(8).optional(),
  effective_to: z.string().min(8).nullable().optional(),
  status: z.enum(["active","inactive"]).optional(),
});

// -----------------------------------------------------------------------------
// Statutory Rules
// -----------------------------------------------------------------------------
const payeBracketSchema = z.object({
  // up_to is inclusive upper bound for this bracket; null means "no upper limit"
  up_to: z.number().positive().optional().nullable(),
  rate: z.number().min(0).max(100),
});

createStatutoryRuleSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  rule_type: z.enum(["income_tax","pension","social_security","health_insurance","other"]),
  calculation_method: z.enum(["flat","progressive"]).default("flat").optional(),
  brackets: z.array(payeBracketSchema).optional(),
  allowance_amount: z.number().min(0).optional(),
  // Accept percentage (e.g., 5.5) or fraction (0.055)
  employee_rate: z.number().min(0).max(100),
  employer_rate: z.number().min(0).max(100),
  base_on: z.enum(["base", "gross"]).default("base").optional(),
  cap_amount: z.number().positive().optional().nullable(),
  expense_account_id: uuid,
  liability_account_id: uuid,
});

const updateStatutoryRuleSchema = z.object({
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  rule_type: z.enum(["income_tax","pension","social_security","health_insurance","other"]).optional(),
  employee_rate: z.number().min(0).max(100).optional(),
  employer_rate: z.number().min(0).max(100).optional(),
  base_on: z.enum(["base", "gross"]).optional(),
  cap_amount: z.number().positive().nullable().optional(),
  expense_account_id: uuid.optional(),
  liability_account_id: uuid.optional(),
  status: z.enum(["active","inactive"]).optional(),
});

// -----------------------------------------------------------------------------
// Employee Import/Export
// -----------------------------------------------------------------------------
const importEmployeesSchema = z.object({
  mode: z.enum(["upsert", "create_only", "update_only"]).default("upsert").optional(),
  employees: z.array(createEmployeeSchema).min(1),
});
module.exports = {
createDepartmentSchema,
  updateDepartmentSchema,
  createGradeSchema,
  updateGradeSchema,
  createPositionSchema,
  updatePositionSchema,
  createCompBandSchema,
  updateCompBandSchema,
  createEmployeeSchema,
  updateEmployeeSchema,
  createLeaveTypeSchema,
  updateLeaveTypeSchema,
  upsertLeaveBalanceSchema,
  createLeaveRequestSchema,
  updateLeaveRequestSchema,
  rejectLeaveRequestSchema,
  createBenefitPlanSchema,
  updateBenefitPlanSchema,
  assignEmployeeBenefitSchema,
  updateEmployeeBenefitSchema,
  createStatutoryRuleSchema,
  updateStatutoryRuleSchema,
};
