-- Stage 6: Vendor tax forms (1099 / local equivalents) - tracking + generation runs

BEGIN;

CREATE TABLE IF NOT EXISTS vendor_tax_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL,
  tin TEXT NULL,
  legal_name TEXT NULL,
  address_line1 TEXT NULL,
  address_line2 TEXT NULL,
  city TEXT NULL,
  state_province TEXT NULL,
  postal_code TEXT NULL,
  country_code TEXT NULL,
  classification TEXT NULL,
  is_reportable BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_vendor_tax_profiles_org_vendor ON vendor_tax_profiles(organization_id, vendor_id);

CREATE TABLE IF NOT EXISTS tax_form_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tax_year INT NOT NULL,
  form_type TEXT NOT NULL DEFAULT '1099',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','generated','finalized','voided')),
  generated_at TIMESTAMPTZ NULL,
  created_by UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_form_runs_org_year_type ON tax_form_runs(organization_id, tax_year, form_type);

CREATE TABLE IF NOT EXISTS tax_forms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES tax_form_runs(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL,
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated','suppressed','finalized')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_tax_forms_run ON tax_forms(run_id);

INSERT INTO permissions(code, description) VALUES
  ('taxforms.read', 'Read tax forms'),
  ('taxforms.manage', 'Manage tax forms')
ON CONFLICT (code) DO NOTHING;

COMMIT;
