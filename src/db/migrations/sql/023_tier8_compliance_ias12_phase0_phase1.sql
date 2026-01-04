-- Tier 8 (Part D): Compliance - IAS 12 Income Taxes
-- Phase 0 + Phase 1
-- Provides: master data + configuration for deferred tax engine

BEGIN;

-- Tax authorities (e.g., GRA). Scoped to organization.
CREATE TABLE IF NOT EXISTS ias12_tax_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  code text NOT NULL,
  name text NOT NULL,
  country_code char(2) NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),

  created_by uuid NULL REFERENCES users(id),
  updated_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(organization_id, code)
);

-- Effective-dated tax rate sets (e.g., Corporate Income Tax).
CREATE TABLE IF NOT EXISTS ias12_tax_rate_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  authority_id uuid NOT NULL REFERENCES ias12_tax_authorities(id) ON DELETE RESTRICT,

  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),

  created_by uuid NULL REFERENCES users(id),
  updated_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(organization_id, code)
);

-- Tax rate lines: effective-dated, non-overlapping per rate set.
CREATE TABLE IF NOT EXISTS ias12_tax_rate_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_set_id uuid NOT NULL REFERENCES ias12_tax_rate_sets(id) ON DELETE CASCADE,

  effective_from date NOT NULL,
  effective_to date NULL,
  rate numeric(9,6) NOT NULL CHECK (rate >= 0 AND rate <= 1),

  created_by uuid NULL REFERENCES users(id),
  updated_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(rate_set_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_ias12_rate_lines_set_from
  ON ias12_tax_rate_lines(rate_set_id, effective_from);

-- Organization-level IAS12 configuration.
-- Includes accounts required for deferred tax postings (Phase 4).
CREATE TABLE IF NOT EXISTS ias12_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

  default_authority_id uuid NULL REFERENCES ias12_tax_authorities(id) ON DELETE SET NULL,
  default_rate_set_id uuid NULL REFERENCES ias12_tax_rate_sets(id) ON DELETE SET NULL,

  deferred_tax_asset_account_id uuid NULL REFERENCES chart_of_accounts(id),
  deferred_tax_liability_account_id uuid NULL REFERENCES chart_of_accounts(id),
  deferred_tax_expense_account_id uuid NULL REFERENCES chart_of_accounts(id),

  rounding_decimals integer NOT NULL DEFAULT 2 CHECK (rounding_decimals >= 0 AND rounding_decimals <= 6),

  created_by uuid NULL REFERENCES users(id),
  updated_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
