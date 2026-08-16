BEGIN;

-- GRA Release 4: Ghana PAYE + SSNIT/Tier 1 + Tier 2 + statutory payroll schedules.
-- Source dates are retained with every ruleset; future law changes must insert a new
-- effective-dated version rather than rewriting historical payroll calculations.

CREATE TABLE IF NOT EXISTS ghana_payroll_rule_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  rules_json JSONB NOT NULL,
  source_authority TEXT NOT NULL,
  source_url TEXT,
  source_note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(code, effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_ghana_payroll_rules_effective
  ON ghana_payroll_rule_versions(code, effective_from, effective_to)
  WHERE status='active';

INSERT INTO ghana_payroll_rule_versions
(code,name,effective_from,effective_to,rules_json,source_authority,source_url,source_note)
VALUES
('GH_PAYE','Ghana PAYE published resident/non-resident employment tax rules','2024-01-01',NULL,
 '{
   "residentMonthlyBands":[
     {"amount":"490.00","rate":"0.00"},
     {"amount":"110.00","rate":"5.00"},
     {"amount":"130.00","rate":"10.00"},
     {"amount":"3166.67","rate":"17.50"},
     {"amount":"16000.00","rate":"25.00"},
     {"amount":"30520.00","rate":"30.00"},
     {"amount":null,"rate":"35.00"}
   ],
   "nonResidentRate":"25.00",
   "nonResidentBonusOvertimeRate":"20.00",
   "casualWorkerRate":"5.00",
   "partTimeResidentRate":"10.00",
   "bonusConcessionRate":"5.00",
   "bonusConcessionPercentOfAnnualBasic":"15.00",
   "overtimeLowerRate":"5.00",
   "overtimeUpperRate":"10.00",
   "overtimeThresholdPercentOfMonthlyBasic":"50.00",
   "overtimeConcessionAnnualIncomeLimit":"18000.00"
 }'::jsonb,
 'Ghana Revenue Authority','https://gra.gov.gh/domestic-tax/tax-types/paye/',
 'Resident monthly bands currently published by GRA took effect 1 January 2024. Bonus up to 15% of annual basic salary is taxed at 5%; casual worker tax is 5%; non-resident chargeable employment income is generally 25% while GRA publishes a 20% rate for non-resident bonus/overtime. The overtime concession is limited to qualifying junior staff and the current GRA page states qualifying employment emolument must not exceed GHS 18,000.'),
('GH_SSNIT','Ghana SSNIT and mandatory Tier 2 contribution rules','2026-01-01',NULL,
 '{
   "employeeRate":"5.50",
   "employerRate":"13.00",
   "totalRate":"18.50",
   "ssnitRemittanceRate":"13.50",
   "tier2Rate":"5.00",
   "minimumInsurableEarnings":"587.80",
   "maximumInsurableEarnings":"69000.00",
   "minimumSsnitRemittance":"79.40",
   "maximumSsnitRemittance":"9315.00",
   "ssnitRemittanceDueDaysAfterMonthEnd":14
 }'::jsonb,
 'Social Security and National Insurance Trust','https://www.ssnit.org.gh/maximum-insurable-earning-increased/',
 'For 2026 SSNIT published minimum insurable earnings of GHS 587.80 and maximum of GHS 69,000, with minimum/maximum Tier-1 contributions payable to SSNIT of GHS 79.40/GHS 9,315.00. Employer guidance states 5.5% employee + 13% employer, with 13.5% remitted to SSNIT and 5% to Tier 2.')
ON CONFLICT (code,effective_from) DO UPDATE SET
  name=EXCLUDED.name,
  rules_json=EXCLUDED.rules_json,
  source_authority=EXCLUDED.source_authority,
  source_url=EXCLUDED.source_url,
  source_note=EXCLUDED.source_note,
  status='active',
  updated_at=NOW();

CREATE TABLE IF NOT EXISTS ghana_payroll_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  paye_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ssnit_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  tier2_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  paye_payable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  ssnit_tier1_payable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  tier2_payable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  employer_pension_expense_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  default_tier2_scheme_name TEXT,
  gra_tax_office TEXT,
  employer_tax_id TEXT,
  ssnit_employer_number TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Organizations that already installed a Ghana tax pack get a Ghana payroll settings
-- row, but the payroll engine stays opt-in until account mappings are reviewed.
INSERT INTO ghana_payroll_settings(organization_id,enabled)
SELECT DISTINCT i.organization_id,FALSE
FROM tax_country_pack_installs i
JOIN tax_country_packs p ON p.id=i.pack_id
WHERE p.country_code='GH'
ON CONFLICT (organization_id) DO NOTHING;

ALTER TABLE hr_employees
  ADD COLUMN IF NOT EXISTS ghana_card_pin TEXT,
  ADD COLUMN IF NOT EXISTS ssnit_number TEXT,
  ADD COLUMN IF NOT EXISTS tier2_member_id TEXT,
  ADD COLUMN IF NOT EXISTS tier2_scheme_name TEXT,
  ADD COLUMN IF NOT EXISTS tax_residency TEXT NOT NULL DEFAULT 'resident',
  ADD COLUMN IF NOT EXISTS worker_classification TEXT NOT NULL DEFAULT 'regular',
  ADD COLUMN IF NOT EXISTS qualifies_overtime_concession BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pension_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS approved_monthly_tax_relief NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employment_end_date DATE;

ALTER TABLE hr_employees DROP CONSTRAINT IF EXISTS chk_hr_employees_tax_residency;
ALTER TABLE hr_employees ADD CONSTRAINT chk_hr_employees_tax_residency
  CHECK (tax_residency IN ('resident','nonresident'));
ALTER TABLE hr_employees DROP CONSTRAINT IF EXISTS chk_hr_employees_worker_classification;
ALTER TABLE hr_employees ADD CONSTRAINT chk_hr_employees_worker_classification
  CHECK (worker_classification IN ('regular','temporary','casual','part_time'));
CREATE INDEX IF NOT EXISTS idx_hr_employees_ghana_card ON hr_employees(organization_id,ghana_card_pin) WHERE ghana_card_pin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hr_employees_ssnit_number ON hr_employees(organization_id,ssnit_number) WHERE ssnit_number IS NOT NULL;

ALTER TABLE hr_payroll_components
  ADD COLUMN IF NOT EXISTS ghana_category TEXT NOT NULL DEFAULT 'regular',
  ADD COLUMN IF NOT EXISTS pensionable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE hr_payroll_components DROP CONSTRAINT IF EXISTS chk_hr_payroll_components_ghana_category;
ALTER TABLE hr_payroll_components ADD CONSTRAINT chk_hr_payroll_components_ghana_category
  CHECK (ghana_category IN ('regular','bonus','overtime','non_taxable','relief','other_deduction'));

ALTER TABLE hr_payroll_runs
  ADD COLUMN IF NOT EXISTS statutory_country_code CHAR(2),
  ADD COLUMN IF NOT EXISTS paye_rule_version_id UUID REFERENCES ghana_payroll_rule_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS pension_rule_version_id UUID REFERENCES ghana_payroll_rule_versions(id) ON DELETE RESTRICT;

ALTER TABLE hr_payroll_run_lines
  ADD COLUMN IF NOT EXISTS taxable_earnings NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chargeable_income NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paye_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overtime_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insurable_earnings NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ssnit_employee NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ssnit_employer NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ssnit_tier1_payable NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tier2_payable NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_employer_cost NUMERIC(18,2) NOT NULL DEFAULT 0;

-- Version generic statutory rules correctly: the former org+code unique index prevented
-- keeping historical rule versions with the same statutory code.
DROP INDEX IF EXISTS ux_hr_statutory_rules_org_code;
CREATE UNIQUE INDEX IF NOT EXISTS ux_hr_statutory_rules_org_code_effective
  ON hr_statutory_rules(organization_id,code,effective_from);

CREATE TABLE IF NOT EXISTS ghana_paye_returns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  form_code TEXT NOT NULL CHECK (form_code IN ('DT107','DT108')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  tax_year INTEGER NOT NULL,
  version_no INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','filed','voided')),
  total_basic_salary NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_gross_pay NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_chargeable_income NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_paye NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_bonus_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_overtime_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_ssnit_employee NUMERIC(18,2) NOT NULL DEFAULT 0,
  gra_reference TEXT,
  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  filed_at TIMESTAMPTZ,
  filed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(organization_id,form_code,period_start,period_end,version_no)
);

CREATE TABLE IF NOT EXISTS ghana_paye_return_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  return_id UUID NOT NULL REFERENCES ghana_paye_returns(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE RESTRICT,
  employee_no TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  employee_tax_id TEXT,
  ghana_card_pin TEXT,
  ssnit_number TEXT,
  worker_classification TEXT,
  tax_residency TEXT,
  basic_salary NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_cash_emoluments NUMERIC(18,2) NOT NULL DEFAULT 0,
  bonus NUMERIC(18,2) NOT NULL DEFAULT 0,
  overtime NUMERIC(18,2) NOT NULL DEFAULT 0,
  gross_pay NUMERIC(18,2) NOT NULL DEFAULT 0,
  ssnit_employee NUMERIC(18,2) NOT NULL DEFAULT 0,
  chargeable_income NUMERIC(18,2) NOT NULL DEFAULT 0,
  graduated_paye NUMERIC(18,2) NOT NULL DEFAULT 0,
  bonus_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  overtime_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_paye NUMERIC(18,2) NOT NULL DEFAULT 0,
  source_run_ids UUID[] NOT NULL DEFAULT '{}',
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(return_id,employee_id)
);
CREATE INDEX IF NOT EXISTS idx_ghana_paye_return_lines_return ON ghana_paye_return_lines(return_id);

CREATE TABLE IF NOT EXISTS ghana_payroll_remittances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  remittance_type TEXT NOT NULL CHECK (remittance_type IN ('PAYE','SSNIT_TIER1','TIER2')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  due_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','paid','voided')),
  payment_reference TEXT,
  settlement_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  paid_at TIMESTAMPTZ,
  paid_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(organization_id,remittance_type,period_start,period_end)
);

INSERT INTO permissions(code,description) VALUES
 ('hr.payroll.ghana.read','Read Ghana PAYE, pension schedules and statutory returns'),
 ('hr.payroll.ghana.manage','Manage Ghana payroll settings, PAYE returns and pension schedules'),
 ('hr.payroll.ghana.file','Finalize/file Ghana PAYE statutory returns')
ON CONFLICT (code) DO NOTHING;

-- Keep existing organization administrators usable after installing the country-pack extension.
INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('hr.payroll.ghana.read','hr.payroll.ghana.manage','hr.payroll.ghana.file')
WHERE lower(r.name) IN ('admin','administrator','super admin','owner')
ON CONFLICT DO NOTHING;

COMMIT;
