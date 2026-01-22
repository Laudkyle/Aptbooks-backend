-- Stage 1: HR Foundation (Employees, Org Structure, Positions, Compensation Bands)

CREATE TABLE IF NOT EXISTS hr_departments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_hr_departments_org_code ON hr_departments(organization_id, code);

CREATE TABLE IF NOT EXISTS hr_grades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  min_amount NUMERIC(18,2),
  max_amount NUMERIC(18,2),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  CHECK (max_amount IS NULL OR min_amount IS NULL OR max_amount >= min_amount)
);

CREATE INDEX IF NOT EXISTS idx_hr_grades_org_code ON hr_grades(organization_id, code);

CREATE TABLE IF NOT EXISTS hr_positions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  department_id UUID REFERENCES hr_departments(id) ON DELETE SET NULL,
  grade_id UUID REFERENCES hr_grades(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_hr_positions_org_code ON hr_positions(organization_id, code);
CREATE INDEX IF NOT EXISTS idx_hr_positions_department ON hr_positions(department_id);

CREATE TABLE IF NOT EXISTS hr_compensation_bands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  min_amount NUMERIC(18,2) NOT NULL,
  max_amount NUMERIC(18,2) NOT NULL,
  pay_frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (pay_frequency IN ('monthly','weekly','daily')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  CHECK (max_amount >= min_amount)
);

CREATE INDEX IF NOT EXISTS idx_hr_comp_bands_org_code ON hr_compensation_bands(organization_id, code);

CREATE TABLE IF NOT EXISTS hr_employees (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_no TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  other_names TEXT,
  email TEXT,
  phone TEXT,
  hire_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','inactive','terminated')),

  department_id UUID REFERENCES hr_departments(id) ON DELETE SET NULL,
  position_id UUID REFERENCES hr_positions(id) ON DELETE SET NULL,
  grade_id UUID REFERENCES hr_grades(id) ON DELETE SET NULL,
  cost_center_id UUID REFERENCES cost_centers(id) ON DELETE SET NULL,

  -- Accounting defaults (used by Stage 2 Payroll journals)
  expense_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  payable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,

  -- Compensation metadata (no payroll computation in Stage 1)
  compensation_band_id UUID REFERENCES hr_compensation_bands(id) ON DELETE SET NULL,
  base_salary_amount NUMERIC(18,2),
  base_salary_currency TEXT,
  base_salary_frequency TEXT CHECK (base_salary_frequency IN ('monthly','weekly','daily')),

  -- Payment identifiers (Stage 2 will use these for payouts)
  bank_name TEXT,
  bank_account_no TEXT,
  bank_branch TEXT,

  tax_id TEXT,
  national_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, employee_no)
);

CREATE INDEX IF NOT EXISTS idx_hr_employees_org_empno ON hr_employees(organization_id, employee_no);
CREATE INDEX IF NOT EXISTS idx_hr_employees_org_status ON hr_employees(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_employees_cost_center ON hr_employees(cost_center_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_department ON hr_employees(department_id);

-- Permissions
INSERT INTO permissions (code, description) VALUES
  ('hr.departments.read', 'Read HR departments'),
  ('hr.departments.manage', 'Create/update/deactivate HR departments'),
  ('hr.grades.read', 'Read HR grades/levels'),
  ('hr.grades.manage', 'Create/update/deactivate HR grades/levels'),
  ('hr.positions.read', 'Read HR positions'),
  ('hr.positions.manage', 'Create/update/deactivate HR positions'),
  ('hr.compensation_bands.read', 'Read HR compensation bands'),
  ('hr.compensation_bands.manage', 'Create/update/deactivate HR compensation bands'),
  ('hr.employees.read', 'Read HR employees'),
  ('hr.employees.manage', 'Create/update/manage HR employees')
ON CONFLICT (code) DO NOTHING;
