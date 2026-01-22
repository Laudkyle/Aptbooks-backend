-- Stage 3: HR Leave, Benefits, Statutory scaffolding, and Reporting hooks

-- ---------------------------------------------------------------------------
-- Leave Types
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_leave_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'days' CHECK (unit IN ('days')),
  is_paid BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_leave_types_org_code ON hr_leave_types(organization_id, code);

-- ---------------------------------------------------------------------------
-- Leave Balances
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_leave_balances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES hr_leave_types(id) ON DELETE CASCADE,
  balance_days NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  UNIQUE (organization_id, employee_id, leave_type_id)
);

CREATE INDEX IF NOT EXISTS ix_hr_leave_balances_employee ON hr_leave_balances(employee_id);
CREATE INDEX IF NOT EXISTS ix_hr_leave_balances_leave_type ON hr_leave_balances(leave_type_id);

-- ---------------------------------------------------------------------------
-- Leave Ledger (audit trail)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_leave_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES hr_leave_types(id) ON DELETE CASCADE,
  delta_days NUMERIC(12,2) NOT NULL,
  reason TEXT,
  ref_type TEXT,
  ref_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_hr_leave_ledger_employee ON hr_leave_ledger(employee_id);
CREATE INDEX IF NOT EXISTS ix_hr_leave_ledger_leave_type ON hr_leave_ledger(leave_type_id);
CREATE INDEX IF NOT EXISTS ix_hr_leave_ledger_ref ON hr_leave_ledger(ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- Leave Requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_leave_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES hr_leave_types(id) ON DELETE RESTRICT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC(12,2) NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','cancelled')),
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_hr_leave_requests_employee ON hr_leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS ix_hr_leave_requests_leave_type ON hr_leave_requests(leave_type_id);
CREATE INDEX IF NOT EXISTS ix_hr_leave_requests_status ON hr_leave_requests(status);

-- ---------------------------------------------------------------------------
-- Benefits
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_benefit_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  employer_rate NUMERIC(8,6) NOT NULL DEFAULT 0,
  employee_rate NUMERIC(8,6) NOT NULL DEFAULT 0,
  expense_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  liability_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_benefit_plans_org_code ON hr_benefit_plans(organization_id, code);

CREATE TABLE IF NOT EXISTS hr_employee_benefits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  benefit_plan_id UUID NOT NULL REFERENCES hr_benefit_plans(id) ON DELETE RESTRICT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_hr_employee_benefits_employee ON hr_employee_benefits(employee_id);
CREATE INDEX IF NOT EXISTS ix_hr_employee_benefits_plan ON hr_employee_benefits(benefit_plan_id);

-- ---------------------------------------------------------------------------
-- Statutory Rules (scaffolding)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_statutory_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('income_tax','pension','social_security','health_insurance','other')),
  employee_rate NUMERIC(8,6) NOT NULL DEFAULT 0,
  employer_rate NUMERIC(8,6) NOT NULL DEFAULT 0,
  expense_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  liability_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_statutory_rules_org_code ON hr_statutory_rules(organization_id, code);

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('hr.leave.read', 'Read HR leave types, balances, and requests'),
  ('hr.leave.manage', 'Manage HR leave types, balances, and requests'),
  ('hr.benefits.read', 'Read HR benefit plans and employee benefits'),
  ('hr.benefits.manage', 'Manage HR benefit plans and employee benefits'),
  ('hr.statutory.read', 'Read HR statutory rules'),
  ('hr.statutory.manage', 'Manage HR statutory rules'),
  ('hr.reports.read', 'Read HR reports')
;
