-- 129_backend_schema_compatibility_fixes.sql
-- Compatibility migration for backend services that referenced tables/columns not
-- created by earlier migrations.

BEGIN;

-- E-invoicing service compatibility
ALTER TABLE e_invoices
  ADD COLUMN IF NOT EXISTS network_reference TEXT,
  ADD COLUMN IF NOT EXISTS last_transmitted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS e_invoice_transmissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  e_invoice_id UUID NOT NULL REFERENCES e_invoices(id) ON DELETE CASCADE,
  adapter_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','submitted','accepted','rejected','failed','cancelled')),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  transmitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_e_invoice_transmissions_org_invoice
  ON e_invoice_transmissions(organization_id, e_invoice_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_e_invoice_transmissions_org_status
  ON e_invoice_transmissions(organization_id, status, created_at DESC);

-- Tax jurisdiction return templates used by reporting/tax/tax.service.js
ALTER TABLE tax_returns DROP CONSTRAINT IF EXISTS tax_returns_tax_type_check;
ALTER TABLE tax_returns
  ADD CONSTRAINT tax_returns_tax_type_check
  CHECK (tax_type IN ('VAT','GST','SALES','WITHHOLDING','IMPORT','OTHER'));

CREATE TABLE IF NOT EXISTS tax_return_jurisdiction_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  jurisdiction_id UUID REFERENCES tax_jurisdictions(id) ON DELETE SET NULL,
  tax_type TEXT NOT NULL DEFAULT 'VAT' CHECK (tax_type IN ('VAT','GST','SALES','WITHHOLDING','IMPORT','OTHER')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  version_no TEXT NOT NULL DEFAULT '1.0.0',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS tax_return_jurisdiction_boxes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES tax_return_jurisdiction_templates(id) ON DELETE CASCADE,
  box_code TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  direction TEXT CHECK (direction IS NULL OR direction IN ('output','input')),
  tax_scope TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, box_code)
);

CREATE INDEX IF NOT EXISTS idx_tax_return_jurisdiction_boxes_template
  ON tax_return_jurisdiction_boxes(template_id, sort_order, box_code);

-- Tax filing runs used by tax reporting and automation services
CREATE TABLE IF NOT EXISTS tax_filing_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  adapter_id UUID REFERENCES tax_filing_adapters(id) ON DELETE SET NULL,
  tax_return_id UUID REFERENCES tax_returns(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL DEFAULT 'tax_return',
  source_id UUID,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','submitted','accepted','rejected','failed','cancelled')),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  transmitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_filing_runs_org_status
  ON tax_filing_runs(organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tax_filing_runs_org_return
  ON tax_filing_runs(organization_id, tax_return_id, created_at DESC);

-- Automation rule service compatibility. Earlier schema used trigger_code/action_json;
-- current service writes code/trigger_type/config_json.
ALTER TABLE tax_automation_rules
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS trigger_type TEXT,
  ADD COLUMN IF NOT EXISTS config_json JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE tax_automation_rules
SET code = COALESCE(code, trigger_code, lower(regexp_replace(name, '[^a-zA-Z0-9]+', '_', 'g')))
WHERE code IS NULL;

UPDATE tax_automation_rules
SET trigger_type = COALESCE(trigger_type, trigger_code, 'scheduled')
WHERE trigger_type IS NULL;

UPDATE tax_automation_rules
SET config_json = COALESCE(NULLIF(config_json, '{}'::jsonb), action_json, '{}'::jsonb);

ALTER TABLE tax_automation_rules
  ALTER COLUMN code SET NOT NULL,
  ALTER COLUMN trigger_type SET DEFAULT 'scheduled';

ALTER TABLE tax_automation_rules
  ALTER COLUMN trigger_code SET DEFAULT 'scheduled';

CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_automation_rules_org_code
  ON tax_automation_rules(organization_id, code);

-- Dimension balance table referenced by analytics. It can be populated by a
-- later posting hook or refresh job; creating it prevents analytics endpoints
-- from failing where dimension posting has not yet been enabled.
CREATE TABLE IF NOT EXISTS general_ledger_dimension_balances (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
  dimension_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  debit_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, period_id, account_id, dimension_json)
);

CREATE INDEX IF NOT EXISTS idx_gl_dimension_balances_dimension_json
  ON general_ledger_dimension_balances USING GIN (dimension_json);

COMMIT;
