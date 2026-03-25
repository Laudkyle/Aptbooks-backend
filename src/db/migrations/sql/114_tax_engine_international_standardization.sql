BEGIN;

ALTER TABLE tax_jurisdictions
  ADD COLUMN IF NOT EXISTS parent_jurisdiction_id UUID REFERENCES tax_jurisdictions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS level_code TEXT NOT NULL DEFAULT 'country',
  ADD COLUMN IF NOT EXISTS region_code TEXT,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tax_codes
  ADD COLUMN IF NOT EXISTS category_code TEXT,
  ADD COLUMN IF NOT EXISTS tax_scope TEXT NOT NULL DEFAULT 'taxable',
  ADD COLUMN IF NOT EXISTS application_scope TEXT NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS calculation_method TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS exemption_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS exemption_reason TEXT,
  ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recoverable_percent NUMERIC(7,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS reporting_group TEXT,
  ADD COLUMN IF NOT EXISTS posting_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_tax_type_check;
ALTER TABLE tax_codes
  ADD CONSTRAINT tax_codes_tax_type_check
  CHECK (tax_type IN ('VAT','GST','SALES','WITHHOLDING','IMPORT','OTHER'));

ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_tax_scope_check;
ALTER TABLE tax_codes ADD CONSTRAINT tax_codes_tax_scope_check
  CHECK (tax_scope IN ('taxable','zero_rated','exempt','out_of_scope','reverse_charge','withholding','import','export','non_recoverable'));

ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_application_scope_check;
ALTER TABLE tax_codes ADD CONSTRAINT tax_codes_application_scope_check
  CHECK (application_scope IN ('sales','purchases','both'));

ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_calculation_method_check;
ALTER TABLE tax_codes ADD CONSTRAINT tax_codes_calculation_method_check
  CHECK (calculation_method IN ('standard','inclusive','deduction','withholding'));

ALTER TABLE tax_settings
  ADD COLUMN IF NOT EXISTS non_recoverable_input_tax_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS withholding_tax_payable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS withholding_tax_receivable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reverse_charge_tax_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tax_rounding_strategy TEXT NOT NULL DEFAULT 'line',
  ADD COLUMN IF NOT EXISTS enforce_partner_tax_profile BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS require_tax_jurisdiction BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS tax_registrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  jurisdiction_id UUID REFERENCES tax_jurisdictions(id) ON DELETE SET NULL,
  registration_no TEXT NOT NULL,
  registration_type TEXT NOT NULL DEFAULT 'VAT',
  legal_entity_name TEXT,
  filing_frequency TEXT NOT NULL DEFAULT 'monthly',
  filing_basis TEXT NOT NULL DEFAULT 'invoice',
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, registration_type, registration_no)
);

CREATE TABLE IF NOT EXISTS tax_partner_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,
  tax_registration_no TEXT,
  legal_name TEXT,
  tax_class TEXT NOT NULL DEFAULT 'standard',
  default_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  purchase_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  sales_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  jurisdiction_id UUID REFERENCES tax_jurisdictions(id) ON DELETE SET NULL,
  place_of_supply TEXT,
  is_tax_registered BOOLEAN NOT NULL DEFAULT FALSE,
  is_tax_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  exemption_reason_code TEXT,
  exemption_reason TEXT,
  reverse_charge_applicable BOOLEAN NOT NULL DEFAULT FALSE,
  withholding_applicable BOOLEAN NOT NULL DEFAULT FALSE,
  withholding_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  recoverable_percent_override NUMERIC(7,4),
  certificate_reference TEXT,
  certificate_expiry DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, partner_id)
);

CREATE TABLE IF NOT EXISTS tax_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  document_type TEXT,
  partner_type TEXT,
  transaction_scope TEXT NOT NULL DEFAULT 'both',
  jurisdiction_id UUID REFERENCES tax_jurisdictions(id) ON DELETE SET NULL,
  tax_code_id UUID NOT NULL REFERENCES tax_codes(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL DEFAULT 100,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tax_document_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS tax_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tax_type TEXT NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, tax_type, from_date, to_date)
);

CREATE TABLE IF NOT EXISTS tax_reconciliation_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES tax_reconciliation_runs(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  issue_code TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE business_partners
  ADD COLUMN IF NOT EXISTS tax_id TEXT,
  ADD COLUMN IF NOT EXISTS tax_country_code CHAR(2),
  ADD COLUMN IF NOT EXISTS tax_registered BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE invoice_lines
  ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE bill_lines
  ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE operational_document_lines
  ADD COLUMN IF NOT EXISTS tax_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE invoice_line_tax_details
  ADD COLUMN IF NOT EXISTS tax_scope TEXT,
  ADD COLUMN IF NOT EXISTS category_code TEXT,
  ADD COLUMN IF NOT EXISTS recoverable_percent NUMERIC(7,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS exemption_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS posting_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_rule_id UUID REFERENCES tax_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE bill_line_tax_details
  ADD COLUMN IF NOT EXISTS tax_scope TEXT,
  ADD COLUMN IF NOT EXISTS category_code TEXT,
  ADD COLUMN IF NOT EXISTS recoverable_percent NUMERIC(7,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS exemption_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS posting_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_rule_id UUID REFERENCES tax_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE operational_doc_line_tax_details
  ADD COLUMN IF NOT EXISTS tax_scope TEXT,
  ADD COLUMN IF NOT EXISTS category_code TEXT,
  ADD COLUMN IF NOT EXISTS recoverable_percent NUMERIC(7,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS exemption_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS posting_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_rule_id UUID REFERENCES tax_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_tax_partner_profiles_org_partner ON tax_partner_profiles(organization_id, partner_id);
CREATE INDEX IF NOT EXISTS idx_tax_rules_org_scope ON tax_rules(organization_id, document_type, transaction_scope, priority);
CREATE INDEX IF NOT EXISTS idx_tax_snapshots_org_source ON tax_document_snapshots(organization_id, source_type, source_id);

INSERT INTO permissions(code, description) VALUES
  ('tax.registration.read', 'Read tax registrations'),
  ('tax.registration.manage', 'Manage tax registrations'),
  ('tax.rule.read', 'Read tax rules'),
  ('tax.rule.manage', 'Manage tax rules'),
  ('tax.reconciliation.read', 'Read tax reconciliation workbench'),
  ('partners.tax.manage', 'Manage business partner tax profiles')
ON CONFLICT (code) DO NOTHING;

COMMIT;
