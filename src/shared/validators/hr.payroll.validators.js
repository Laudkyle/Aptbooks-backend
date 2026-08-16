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
  ghana_category: z.enum(["regular", "bonus", "overtime", "non_taxable", "relief", "other_deduction"]).optional().default("regular"),
  pensionable: z.boolean().optional().default(false),
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

const ghanaPayrollSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  payeEnabled: z.boolean().optional(),
  ssnitEnabled: z.boolean().optional(),
  tier2Enabled: z.boolean().optional(),
  payePayableAccountId: z.string().uuid().nullable().optional(),
  ssnitTier1PayableAccountId: z.string().uuid().nullable().optional(),
  tier2PayableAccountId: z.string().uuid().nullable().optional(),
  employerPensionExpenseAccountId: z.string().uuid().nullable().optional(),
  defaultTier2SchemeName: z.string().max(200).nullable().optional(),
  graTaxOffice: z.string().max(200).nullable().optional(),
  employerTaxId: z.string().max(100).nullable().optional(),
  ssnitEmployerNumber: z.string().max(100).nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

const ghanaPreparePayeReturnSchema = z.object({
  formCode: z.enum(["DT107", "DT108"]),
  periodStart: z.string().min(8),
  periodEnd: z.string().min(8),
});
const ghanaMarkPayeFiledSchema = z.object({ graReference: z.string().max(200).optional().nullable() });
const ghanaPrepareRemittanceSchema = z.object({
  type: z.enum(["PAYE", "SSNIT_TIER1", "TIER2"]),
  periodStart: z.string().min(8),
  periodEnd: z.string().min(8),
});
const ghanaMarkRemittancePaidSchema = z.object({
  settlementAccountId: z.string().uuid(),
  paymentDate: z.string().min(8),
  paymentReference: z.string().max(200).optional().nullable(),
});

module.exports = {
  createPayrollComponentSchema,
  updatePayrollComponentSchema,
  assignEmployeeComponentSchema,
  updateEmployeeComponentSchema,
  createPayrollRunSchema,
  updatePayrollRunSchema,
  ghanaPayrollSettingsSchema,
  ghanaPreparePayeReturnSchema,
  ghanaMarkPayeFiledSchema,
  ghanaPrepareRemittanceSchema,
  ghanaMarkRemittancePaidSchema,
};
