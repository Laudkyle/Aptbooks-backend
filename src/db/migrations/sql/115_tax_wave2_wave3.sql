BEGIN;

ALTER TABLE tax_partner_profiles
  ADD COLUMN IF NOT EXISTS input_tax_recovery_mode TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS destination_country_code CHAR(2),
  ADD COLUMN IF NOT EXISTS registration_status TEXT NOT NULL DEFAULT 'registered',
  ADD COLUMN IF NOT EXISTS e_invoice_network TEXT,
  ADD COLUMN IF NOT EXISTS e_invoice_endpoint TEXT;

ALTER TABLE tax_partner_profiles DROP CONSTRAINT IF EXISTS tax_partner_profiles_input_tax_recovery_mode_check;
ALTER TABLE tax_partner_profiles
  ADD CONSTRAINT tax_partner_profiles_input_tax_recovery_mode_check
  CHECK (input_tax_recovery_mode IN ('default','fully_recoverable','partially_recoverable','non_recoverable'));

ALTER TABLE tax_partner_profiles DROP CONSTRAINT IF EXISTS tax_partner_profiles_registration_status_check;
ALTER TABLE tax_partner_profiles
  ADD CONSTRAINT tax_partner_profiles_registration_status_check
  CHECK (registration_status IN ('registered','unregistered','pending','suspended'));

ALTER TABLE e_invoices
  ADD COLUMN IF NOT EXISTS payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS profile_code TEXT,
  ADD COLUMN IF NOT EXISTS endpoint_id TEXT,
  ADD COLUMN IF NOT EXISTS filing_adapter_code TEXT,
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE tax_returns
  ADD COLUMN IF NOT EXISTS jurisdiction_id UUID REFERENCES tax_jurisdictions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS filing_adapter_code TEXT,
  ADD COLUMN IF NOT EXISTS filing_reference TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE tax_returns DROP CONSTRAINT IF EXISTS tax_returns_status_check;
ALTER TABLE tax_returns
  ADD CONSTRAINT tax_returns_status_check
  CHECK (status IN ('draft','queued','submitted','accepted','rejected','finalized','voided'));

CREATE TABLE IF NOT EXISTS tax_country_packs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  pack_code TEXT NOT NULL,
  country_code CHAR(2) NOT NULL,
  name TEXT NOT NULL,
  version_no TEXT NOT NULL DEFAULT '1.0.0',
  default_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, pack_code)
);

CREATE TABLE IF NOT EXISTS tax_country_pack_installs (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pack_id UUID NOT NULL REFERENCES tax_country_packs(id) ON DELETE CASCADE,
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, pack_id)
);

CREATE TABLE IF NOT EXISTS tax_filing_adapters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  adapter_code TEXT NOT NULL,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL DEFAULT 'api',
  supported_tax_types TEXT[] NOT NULL DEFAULT ARRAY['VAT'],
  supported_countries TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    country_code CHAR(2) NOT NULL,

  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_realtime BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, adapter_code)
);

CREATE TABLE IF NOT EXISTS tax_filing_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tax_return_id UUID REFERENCES tax_returns(id) ON DELETE CASCADE,
  e_invoice_id UUID REFERENCES e_invoices(id) ON DELETE CASCADE,
  adapter_code TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tax_automation_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_code TEXT NOT NULL,
  schedule_code TEXT,
  scope_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS tax_automation_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES tax_automation_rules(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO permissions(code, description) VALUES
  ('tax.automation.read', 'Read tax automation'),
  ('tax.automation.manage', 'Manage tax automation')
ON CONFLICT (code) DO NOTHING;

INSERT INTO tax_country_packs(organization_id, pack_code, country_code, name, default_templates, metadata, is_active)
VALUES
  (NULL, 'GH-VAT-STD', 'GH', 'Ghana VAT Standard Pack',
   '[{"taxType":"VAT","code":"GH_VAT_STD","name":"Ghana VAT Standard","boxes":[{"boxCode":"OUTPUT_VAT","label":"Output VAT","sortOrder":10,"direction":"output"},{"boxCode":"INPUT_VAT","label":"Input VAT","sortOrder":20,"direction":"input"},{"boxCode":"NET_VAT","label":"Net VAT","sortOrder":30,"direction":"output"}]}]'::jsonb,
   '{"filing":"monthly","currency":"GHS"}'::jsonb, TRUE),
  (NULL, 'UK-VAT-MTD', 'GB', 'UK VAT MTD Pack',
   '[{"taxType":"VAT","code":"UK_MTD","name":"UK VAT MTD","boxes":[{"boxCode":"BOX1","label":"VAT due on sales","sortOrder":10,"direction":"output"},{"boxCode":"BOX4","label":"VAT reclaimed on purchases","sortOrder":40,"direction":"input"},{"boxCode":"BOX5","label":"Net VAT","sortOrder":50,"direction":"output"}]}]'::jsonb,
   '{"filing":"quarterly","digital_links_required":true}'::jsonb, TRUE),
  (NULL, 'EU-OSS', 'EU', 'EU OSS VAT Pack',
   '[{"taxType":"VAT","code":"EU_OSS","name":"EU OSS","boxes":[{"boxCode":"OSS_SALES","label":"Eligible sales","sortOrder":10,"direction":"output"},{"boxCode":"OSS_VAT","label":"VAT due","sortOrder":20,"direction":"output"}]}]'::jsonb,
   '{"filing":"quarterly","scheme":"OSS"}'::jsonb, TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO tax_filing_adapters(organization_id, adapter_code, name, channel_type, supported_tax_types, supported_countries, config_json, is_realtime, is_active)
VALUES
  (NULL, 'MANUAL_CSV', 'Manual CSV Export', 'file', ARRAY['VAT','GST'], ARRAY['GH','GB','EU'], '{"format":"csv"}'::jsonb, FALSE, TRUE),
  (NULL, 'PEPPOL_SIM', 'Peppol Simulation Adapter', 'api', ARRAY['VAT'], ARRAY['GB','EU'], '{"network":"peppol"}'::jsonb, TRUE, TRUE),
  (NULL, 'GRA_SIM', 'GRA Simulation Adapter', 'api', ARRAY['VAT','WITHHOLDING'], ARRAY['GH'], '{"authority":"GRA"}'::jsonb, TRUE, TRUE)
ON CONFLICT DO NOTHING;


CREATE TABLE IF NOT EXISTS einvoicing_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  provider VARCHAR(100),
  api_endpoint TEXT,
  api_key TEXT,
  api_secret TEXT,
  sandbox_mode BOOLEAN NOT NULL DEFAULT TRUE,
  document_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(organization_id)
);

-- ==================== TAX RETURN CONFIGURATION ====================
CREATE TABLE IF NOT EXISTS tax_return_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  default_template_id UUID REFERENCES tax_return_templates(id) ON DELETE SET NULL,
  auto_submit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  notification_email VARCHAR(255),
  filing_method VARCHAR(50) DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(organization_id)
);
COMMIT;
