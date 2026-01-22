-- Stage 2: HR Payroll (Components, Employee Assignments, Runs, Posting Link)

CREATE TABLE IF NOT EXISTS hr_payroll_components (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('earning','deduction')),
  calculation_method TEXT NOT NULL DEFAULT 'fixed' CHECK (calculation_method IN ('fixed','percent_base')),

  -- For earnings: optional override expense account. If null, employee.expense_account_id is used.
  expense_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  -- For deductions: liability/payable account that will be credited.
  liability_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,

  is_taxable BOOLEAN NOT NULL DEFAULT FALSE,
  is_statutory BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_hr_payroll_components_org_code ON hr_payroll_components(organization_id, code);

CREATE TABLE IF NOT EXISTS hr_employee_pay_components (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  component_id UUID NOT NULL REFERENCES hr_payroll_components(id) ON DELETE CASCADE,

  -- One of amount or percent should be provided depending on component.calculation_method
  amount NUMERIC(18,2),
  percent NUMERIC(9,4),

  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id, employee_id, component_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_emp_pay_comp_org_emp ON hr_employee_pay_components(organization_id, employee_id);

CREATE TABLE IF NOT EXISTS hr_payroll_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  pay_date DATE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','calculated','posted','voided')),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, period_id, pay_date)
);

CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_org_period ON hr_payroll_runs(organization_id, period_id);

CREATE TABLE IF NOT EXISTS hr_payroll_run_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payroll_run_id UUID NOT NULL REFERENCES hr_payroll_runs(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE RESTRICT,
  base_salary NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_earnings NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(18,2) NOT NULL DEFAULT 0,
  gross_pay NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GHS',
  breakdown_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, payroll_run_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_hr_payroll_run_lines_run ON hr_payroll_run_lines(payroll_run_id);

CREATE TABLE IF NOT EXISTS hr_payroll_run_postings (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payroll_run_id UUID NOT NULL REFERENCES hr_payroll_runs(id) ON DELETE CASCADE,
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES users(id),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, payroll_run_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_payroll_postings_journal ON hr_payroll_run_postings(journal_entry_id);

-- Permissions
INSERT INTO permissions (code, description) VALUES
  ('hr.payroll.read', 'Read payroll setup and payroll runs'),
  ('hr.payroll.manage', 'Create/update payroll components, assignments, and runs'),
  ('hr.payroll.post', 'Post payroll journals to GL')
ON CONFLICT (code) DO NOTHING;
