-- 049_stage6_tax_returns.sql
-- Stage 6: VAT/GST return packaging (box-based) and liability roll-forward

BEGIN;

-- Add box mapping and direction to tax codes
ALTER TABLE tax_codes
  ADD COLUMN IF NOT EXISTS direction TEXT NULL CHECK (direction IS NULL OR direction IN ('output','input')),
  ADD COLUMN IF NOT EXISTS box_code TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_tax_codes_org_box
  ON tax_codes(organization_id, box_code);

-- Return templates define which box codes to show and the ordering
CREATE TABLE IF NOT EXISTS tax_return_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tax_type TEXT NOT NULL CHECK (tax_type IN ('VAT','GST','SALES')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, tax_type, code)
);

CREATE TABLE IF NOT EXISTS tax_return_template_boxes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES tax_return_templates(id) ON DELETE CASCADE,
  box_code TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  direction TEXT NULL CHECK (direction IS NULL OR direction IN ('output','input')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(template_id, box_code)
);

-- Persisted filed (or draft) returns
CREATE TABLE IF NOT EXISTS tax_returns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tax_type TEXT NOT NULL CHECK (tax_type IN ('VAT','GST','SALES')),
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','voided')),
  template_id UUID REFERENCES tax_return_templates(id) ON DELETE SET NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(organization_id, tax_type, from_date, to_date, status)
);

CREATE INDEX IF NOT EXISTS idx_tax_returns_org_period
  ON tax_returns(organization_id, tax_type, from_date, to_date);

COMMIT;
