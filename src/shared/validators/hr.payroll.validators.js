const { z } = require("zod");

const componentKind = z.enum(["earning", "deduction"]);
const calcMethod = z.enum(["fixed", "percent_base"]);

const createPayrollComponentSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  kind: componentKind,
  calculation_method: calcMethod.default("fixed"),
  expense_account_id: z.string().uuid().optional().nullable(),
  liability_account_id: z.string().uuid().optional().nullable(),
  is_taxable: z.boolean().optional().default(false),
  is_statutory: z.boolean().optional().default(false),
  status: z.enum(["active", "inactive"]).optional().default("active"),
});

const updatePayrollComponentSchema = createPayrollComponentSchema.partial();

const assignEmployeeComponentSchema = z.object({
  employee_id: z.string().uuid(),
  component_id: z.string().uuid(),
  amount: z.number().nonnegative().optional().nullable(),
  percent: z.number().nonnegative().max(100).optional().nullable(),
  status: z.enum(["active", "inactive"]).optional().default("active"),
});

const updateEmployeeComponentSchema = assignEmployeeComponentSchema.partial();

const createPayrollRunSchema = z.object({
  period_id: z.string().uuid(),
  pay_date: z.string().min(8),
  currency: z.string().min(3).max(3).optional(),
});

const updatePayrollRunSchema = z.object({
  period_id: z.string().uuid().optional(),
  pay_date: z.string().min(8).optional(),
  currency: z.string().min(3).max(3).optional(),
});

module.exports = {
  createPayrollComponentSchema,
  updatePayrollComponentSchema,
  assignEmployeeComponentSchema,
  updateEmployeeComponentSchema,
  createPayrollRunSchema,
  updatePayrollRunSchema,
};
