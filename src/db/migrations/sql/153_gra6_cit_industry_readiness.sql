BEGIN;

-- GRA Release 6: Corporate Income Tax, tax capital allowances, Ghana industry packs,
-- and consolidated Ghana compliance readiness.

CREATE TABLE IF NOT EXISTS ghana_cit_rate_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  tax_rate NUMERIC(9,6) NOT NULL CHECK (tax_rate >= 0),
  qualification_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_authority TEXT NOT NULL DEFAULT 'Ghana Revenue Authority',
  source_url TEXT,
  source_note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(code,effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

INSERT INTO ghana_cit_rate_versions
(code,name,effective_from,tax_rate,qualification_json,source_url,source_note)
VALUES
('GH_CIT_GENERAL','General Corporate Income Tax','2016-01-01',25.000000,'{}'::jsonb,
 'https://gra.gov.gh/domestic-tax/tax-types/corporate-income-tax/',
 'General company rate published by GRA. Special rates depend on industry, location and qualification and must be explicitly selected/reviewed.'),
('GH_CIT_HOTEL','Company principally engaged in hotel industry','2016-01-01',22.000000,'{"industry":"hotel"}'::jsonb,
 'https://gra.gov.gh/domestic-tax/tax-types/corporate-income-tax/',
 'Published GRA industry rate. Eligibility must be reviewed before use.'),
('GH_CIT_NON_TRAD_EXPORT','Non-traditional exports','2016-01-01',8.000000,'{"activity":"non_traditional_export"}'::jsonb,
 'https://gra.gov.gh/domestic-tax/tax-types/corporate-income-tax/',
 'Published GRA rate for qualifying non-traditional export income.'),
('GH_CIT_MANUFACTURING_REGIONAL','Manufacturing in regional capitals except Accra/Tema','2016-01-01',18.500000,'{"industry":"manufacturing","locationClass":"regional_capital_except_accra_tema"}'::jsonb,
 'https://gra.gov.gh/domestic-tax/tax-types/corporate-income-tax/',
 'Published location-specific rate; qualification must be reviewed.'),
('GH_CIT_MANUFACTURING_OUTSIDE','Manufacturing outside Accra/Tema/regional capitals','2016-01-01',12.500000,'{"industry":"manufacturing","locationClass":"outside_accra_tema_regional_capitals"}'::jsonb,
 'https://gra.gov.gh/domestic-tax/tax-types/corporate-income-tax/',
 'Published location-specific rate; qualification must be reviewed.'),
('GH_CIT_PETROLEUM','Petroleum income tax','2016-01-01',35.000000,'{"industry":"petroleum"}'::jsonb,
 'https://gra.gov.gh/domestic-tax/tax-types/corporate-income-tax/',
 'Published GRA petroleum income tax rate.'),
('GH_CIT_MINING','Mineral income tax','2016-01-01',35.000000,'{"industry":"mining"}'::jsonb,
 'https://gra.gov.gh/domestic-tax/tax-types/corporate-income-tax/',
 'Published GRA mineral income tax rate.')
ON CONFLICT(code,effective_from) DO UPDATE SET
  name=EXCLUDED.name,
  tax_rate=EXCLUDED.tax_rate,
  qualification_json=EXCLUDED.qualification_json,
  source_url=EXCLUDED.source_url,
  source_note=EXCLUDED.source_note,
  status='active',
  updated_at=NOW();

CREATE TABLE IF NOT EXISTS ghana_cit_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  default_rate_version_id UUID REFERENCES ghana_cit_rate_versions(id) ON DELETE RESTRICT,
  basis_period_start_month SMALLINT NOT NULL DEFAULT 1 CHECK (basis_period_start_month BETWEEN 1 AND 12),
  basis_period_end_month SMALLINT NOT NULL DEFAULT 12 CHECK (basis_period_end_month BETWEEN 1 AND 12),
  cit_payable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  cit_expense_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  tax_credit_receivable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  gra_tax_office TEXT,
  taxpayer_id TEXT,
  industry_rate_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO ghana_cit_settings(organization_id,default_rate_version_id)
SELECT o.id, r.id
FROM organizations o
CROSS JOIN LATERAL (
  SELECT id FROM ghana_cit_rate_versions WHERE code='GH_CIT_GENERAL' AND status='active' ORDER BY effective_from DESC LIMIT 1
) r
ON CONFLICT (organization_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ghana_cit_computations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  basis_period_start DATE NOT NULL,
  basis_period_end DATE NOT NULL,
  version_no INTEGER NOT NULL DEFAULT 1,
  form_code TEXT NOT NULL DEFAULT 'DT101' CHECK (form_code='DT101'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','filed','voided')),
  rate_version_id UUID NOT NULL REFERENCES ghana_cit_rate_versions(id) ON DELETE RESTRICT,
  accounting_profit NUMERIC(18,2) NOT NULL DEFAULT 0,
  add_backs NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_assessable_income NUMERIC(18,2) NOT NULL DEFAULT 0,
  allowable_deductions NUMERIC(18,2) NOT NULL DEFAULT 0,
  adjusted_profit NUMERIC(18,2) NOT NULL DEFAULT 0,
  capital_allowance NUMERIC(18,2) NOT NULL DEFAULT 0,
  loss_relief NUMERIC(18,2) NOT NULL DEFAULT 0,
  chargeable_income NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9,6) NOT NULL,
  gross_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  withholding_credits NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_tax_credits NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_after_credits NUMERIC(18,2) NOT NULL DEFAULT 0,
  instalments_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_tax_payable NUMERIC(18,2) NOT NULL DEFAULT 0,
  overpayment NUMERIC(18,2) NOT NULL DEFAULT 0,
  annual_return_due_date DATE NOT NULL,
  calculation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  gra_reference TEXT,
  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  filed_at TIMESTAMPTZ,
  filed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,tax_year,version_no),
  CHECK (basis_period_end >= basis_period_start)
);

CREATE INDEX IF NOT EXISTS idx_ghana_cit_computations_org_year
  ON ghana_cit_computations(organization_id,tax_year,status);

CREATE TABLE IF NOT EXISTS ghana_cit_adjustments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  computation_id UUID NOT NULL REFERENCES ghana_cit_computations(id) ON DELETE CASCADE,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('add_back','deduction','other_income','loss_relief','tax_credit','note')),
  code TEXT,
  description TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  source_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  legal_reference TEXT,
  evidence_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ghana_cit_adjustments_computation
  ON ghana_cit_adjustments(organization_id,computation_id,adjustment_type);

CREATE TABLE IF NOT EXISTS ghana_cit_self_assessments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  version_no INTEGER NOT NULL DEFAULT 1,
  form_code TEXT NOT NULL CHECK (form_code IN ('DT102','DT102A')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','filed','voided')),
  rate_version_id UUID NOT NULL REFERENCES ghana_cit_rate_versions(id) ON DELETE RESTRICT,
  estimated_chargeable_income NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(9,6) NOT NULL,
  gross_estimated_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_credits NUMERIC(18,2) NOT NULL DEFAULT 0,
  estimated_annual_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  instalments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasons_for_revision TEXT,
  gra_reference TEXT,
  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  filed_at TIMESTAMPTZ,
  filed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,tax_year,version_no)
);

-- Current GRA capital allowance classifications under Act 896 as amended.
CREATE TABLE IF NOT EXISTS ghana_tax_asset_classes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('reducing_balance','straight_line','useful_life')),
  rate NUMERIC(9,6),
  useful_life_required BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from DATE NOT NULL,
  effective_to DATE,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

INSERT INTO ghana_tax_asset_classes(code,name,description,method,rate,useful_life_required,effective_from,source_url)
VALUES
('GH_CA_CLASS_1','Class 1','Computers, data handling equipment and peripheral devices','reducing_balance',40.000000,FALSE,'2016-01-01','https://gra.gov.gh/domestic-tax/capital-allowance/'),
('GH_CA_CLASS_2','Class 2','Automobiles, buses/minibuses, goods vehicles, construction/earth-moving equipment, heavy trucks, trailers, qualifying manufacturing plant and machinery, and qualifying plantation expenditure','reducing_balance',30.000000,FALSE,'2016-01-01','https://gra.gov.gh/domestic-tax/capital-allowance/'),
('GH_CA_CLASS_3','Class 3','Rail/water/air transport equipment, specialised public utility plant/equipment, office furniture/fixtures/equipment and other depreciable assets not otherwise classified','reducing_balance',20.000000,FALSE,'2016-01-01','https://gra.gov.gh/domestic-tax/capital-allowance/'),
('GH_CA_CLASS_4','Class 4','Buildings, structures and similar permanent works','straight_line',10.000000,FALSE,'2016-01-01','https://gra.gov.gh/domestic-tax/capital-allowance/'),
('GH_CA_CLASS_5','Class 5','Intangible assets','useful_life',NULL,TRUE,'2016-01-01','https://gra.gov.gh/domestic-tax/capital-allowance/')
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  method=EXCLUDED.method,
  rate=EXCLUDED.rate,
  useful_life_required=EXCLUDED.useful_life_required,
  source_url=EXCLUDED.source_url,
  status='active';

CREATE TABLE IF NOT EXISTS ghana_tax_assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fixed_asset_id UUID REFERENCES fixed_assets(id) ON DELETE SET NULL,
  asset_class_id UUID NOT NULL REFERENCES ghana_tax_asset_classes(id) ON DELETE RESTRICT,
  tax_asset_code TEXT NOT NULL,
  description TEXT NOT NULL,
  first_use_date DATE NOT NULL,
  tax_cost NUMERIC(18,2) NOT NULL CHECK (tax_cost >= 0),
  business_use_percent NUMERIC(9,6) NOT NULL DEFAULT 100 CHECK (business_use_percent BETWEEN 0 AND 100),
  useful_life_years INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disposed','inactive')),
  disposal_date DATE,
  disposal_proceeds NUMERIC(18,2),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,tax_asset_code),
  UNIQUE(organization_id,fixed_asset_id),
  CHECK (useful_life_years IS NULL OR useful_life_years > 0)
);

CREATE TABLE IF NOT EXISTS ghana_capital_allowance_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  basis_period_start DATE NOT NULL,
  basis_period_end DATE NOT NULL,
  version_no INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','voided')),
  total_opening_wdv NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_additions NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_disposals NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_capital_allowance NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_closing_wdv NUMERIC(18,2) NOT NULL DEFAULT 0,
  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,tax_year,version_no),
  CHECK (basis_period_end >= basis_period_start)
);

CREATE TABLE IF NOT EXISTS ghana_capital_allowance_run_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES ghana_capital_allowance_runs(id) ON DELETE CASCADE,
  tax_asset_id UUID REFERENCES ghana_tax_assets(id) ON DELETE SET NULL,
  asset_class_id UUID NOT NULL REFERENCES ghana_tax_asset_classes(id) ON DELETE RESTRICT,
  asset_code TEXT NOT NULL,
  description TEXT NOT NULL,
  opening_wdv NUMERIC(18,2) NOT NULL DEFAULT 0,
  additions NUMERIC(18,2) NOT NULL DEFAULT 0,
  disposals NUMERIC(18,2) NOT NULL DEFAULT 0,
  rate NUMERIC(9,6),
  method TEXT NOT NULL,
  days_in_basis_period INTEGER NOT NULL,
  capital_allowance NUMERIC(18,2) NOT NULL DEFAULT 0,
  closing_wdv NUMERIC(18,2) NOT NULL DEFAULT 0,
  calculation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ghana_ca_lines_run ON ghana_capital_allowance_run_lines(organization_id,run_id);

-- Sector templates deliberately recommend classifications/workflows but do not silently decide legal tax treatment.
CREATE TABLE IF NOT EXISTS ghana_industry_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  capabilities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_catalog_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  compliance_checks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ghana_industry_profiles(code,name,description,capabilities_json,recommended_catalog_json,compliance_checks_json)
VALUES
('GH_HOSPITAL','Hospital / Clinic','Finance and tax profile for hospitals, clinics, pharmacies and diagnostic providers.',
 '["patient_receivables","insurance_receivables","pharmacy_inventory","payroll","fixed_assets","mixed_supply_vat","withholding","e_vat"]'::jsonb,
 '[{"code":"MEDICAL_SERVICE","label":"Medical/clinical service","reviewRequired":true},{"code":"PHARMACY_ITEM","label":"Pharmaceutical/medical item","reviewRequired":true},{"code":"COMMERCIAL_ANCILLARY","label":"Commercial ancillary service","reviewRequired":true}]'::jsonb,
 '["classify_each_medical_service_or_item","review_mixed_taxable_exempt_inputs","reconcile_pharmacy_pos_to_vat","review_insurer_and_corporate_payer_tax_profiles"]'::jsonb),
('GH_SCHOOL','School / Educational Institution','Finance and tax profile for schools, universities, training institutions and education groups.',
 '["student_receivables","fee_structures","payroll","fixed_assets","budgets","mixed_supply_vat","withholding"]'::jsonb,
 '[{"code":"EDUCATIONAL_SERVICE","label":"Educational service","reviewRequired":true},{"code":"UNIFORM_BOOKS","label":"Books/uniforms/materials","reviewRequired":true},{"code":"COMMERCIAL_SERVICE","label":"Commercial ancillary service","reviewRequired":true}]'::jsonb,
 '["classify_each_fee_or_service","review_mixed_taxable_exempt_inputs","reconcile_student_receivables","review_payroll_and_paye"]'::jsonb),
('GH_MART','Mart / Supermarket','High-volume retail profile for supermarkets, marts and multi-branch retailers.',
 '["inventory","barcode_pos","multi_branch","vat","e_vat","payments","reconciliation","withholding"]'::jsonb,
 '[{"code":"STANDARD_SKU","label":"Standard-rated SKU","reviewRequired":true},{"code":"EXEMPT_SKU","label":"Exempt SKU","reviewRequired":true},{"code":"ZERO_RATED_SKU","label":"Zero-rated SKU","reviewRequired":true}]'::jsonb,
 '["classify_all_active_skus","assign_fiscal_devices","reconcile_pos_tax_to_tax_ledger","monitor_vat_registration","monitor_e_vat_queue"]'::jsonb),
('GH_HOTEL_RESTAURANT','Hotel / Restaurant','Hospitality profile for hotels, restaurants, conference facilities and related services.',
 '["pos","inventory","payroll","fixed_assets","vat","e_vat","withholding","cit"]'::jsonb,
 '[{"code":"ROOM","label":"Accommodation","reviewRequired":true},{"code":"FOOD_BEVERAGE","label":"Food/beverage","reviewRequired":true},{"code":"FACILITY_HIRE","label":"Facility hire","reviewRequired":true}]'::jsonb,
 '["review_hospitality_tax_codes","assign_fiscal_devices","review_cit_rate_eligibility","reconcile_pos_to_tax_ledger"]'::jsonb),
('GH_PROFESSIONAL_SERVICES','Professional Services','Profile for consulting, legal, accounting, technology and other service firms.',
 '["projects","time_billing","receivables","vat","withholding","payroll","cit"]'::jsonb,
 '[{"code":"PROFESSIONAL_SERVICE","label":"Professional service","reviewRequired":true}]'::jsonb,
 '["review_service_vat_classification","review_income_wht_certificates","reconcile_project_revenue","prepare_cit"]'::jsonb),
('GH_GENERAL_TRADING','General Trading / Distribution','General-purpose Ghana trading and distribution profile.',
 '["inventory","sales","purchasing","vat","withholding","payments","cit","fixed_assets"]'::jsonb,
 '[{"code":"TRADING_GOODS","label":"Trading goods","reviewRequired":true}]'::jsonb,
 '["classify_inventory","monitor_vat_registration","review_vendor_wht_profiles","prepare_cit"]'::jsonb)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  capabilities_json=EXCLUDED.capabilities_json,
  recommended_catalog_json=EXCLUDED.recommended_catalog_json,
  compliance_checks_json=EXCLUDED.compliance_checks_json,
  status='active',
  updated_at=NOW();

CREATE TABLE IF NOT EXISTS organization_industry_profiles (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  industry_profile_id UUID NOT NULL REFERENCES ghana_industry_profiles(id) ON DELETE RESTRICT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ghana_readiness_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  score NUMERIC(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK (status IN ('not_ready','in_progress','ready','ready_with_warnings')),
  checks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  blockers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ghana_readiness_org_generated ON ghana_readiness_snapshots(organization_id,generated_at DESC);

INSERT INTO permissions(code,description) VALUES
('tax.ghana.cit.read','Read Ghana CIT and capital allowance records'),
('tax.ghana.cit.manage','Manage Ghana CIT, self assessments and capital allowances'),
('tax.ghana.cit.file','Finalize/file Ghana CIT records'),
('tax.ghana.industry.manage','Install/review Ghana industry profiles'),
('tax.ghana.readiness.read','Read Ghana compliance readiness dashboard')
ON CONFLICT(code) DO NOTHING;

-- Grant Release 6 permissions to standard owner/admin style roles, preserving custom-role control.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code IN ('tax.ghana.cit.read','tax.ghana.cit.manage','tax.ghana.cit.file','tax.ghana.industry.manage','tax.ghana.readiness.read')
WHERE LOWER(r.name) IN ('admin','administrator','super admin','superadmin','owner')
ON CONFLICT DO NOTHING;

COMMIT;
