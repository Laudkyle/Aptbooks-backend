-- 045_tax_engine_base_stage5.sql
-- Stage 5: Minimal tax engine scaffolding (VAT/GST capable)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TAX JURISDICTIONS + TAX CODES
-- ============================================================

CREATE TABLE IF NOT EXISTS tax_jurisdictions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  country_code CHAR(2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS tax_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  jurisdiction_id UUID REFERENCES tax_jurisdictions(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  tax_type TEXT NOT NULL CHECK (tax_type IN ('VAT','GST','SALES')),
  rate NUMERIC(9,6) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  is_compound BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_tax_codes_org_status
  ON tax_codes(organization_id, status);

-- ============================================================
-- ORG TAX SETTINGS (where output/input VAT should post)
-- ============================================================

CREATE TABLE IF NOT EXISTS tax_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  output_tax_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  input_tax_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  default_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure each org has a row (optional defaults)
INSERT INTO tax_settings(organization_id)
SELECT id FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

-- ============================================================
-- ADD TAX FIELDS TO INVOICE/BILL LINES (optional)
-- ============================================================

ALTER TABLE invoice_lines
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0);

ALTER TABLE bill_lines
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0);

-- Totals at header level for reporting (do not change posting behaviour yet)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS tax_total NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS tax_total NUMERIC(18,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_invoice_lines_tax_code
  ON invoice_lines(tax_code_id);

CREATE INDEX IF NOT EXISTS idx_bill_lines_tax_code
  ON bill_lines(tax_code_id);
