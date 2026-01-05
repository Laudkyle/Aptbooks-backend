-- IAS 12 (Tier 8D) Stage 1: Temporary differences + deferred tax runs + movement-based postings

BEGIN;

-- Ensure UUID generators exist (deployment-safe)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS ias12_temp_difference_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_ias12_tdc_org ON ias12_temp_difference_categories(organization_id);

CREATE TABLE IF NOT EXISTS ias12_temp_differences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  category_id UUID NOT NULL REFERENCES ias12_temp_difference_categories(id) ON DELETE RESTRICT,
  source_type TEXT,
  source_id UUID,
  diff_type TEXT NOT NULL CHECK (diff_type IN ('DEDUCTIBLE','TAXABLE')),
  carrying_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_base NUMERIC(18,2) NOT NULL DEFAULT 0,
  recognisable BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ias12_td_org_period ON ias12_temp_differences(organization_id, period_id);
CREATE INDEX IF NOT EXISTS idx_ias12_td_category ON ias12_temp_differences(category_id);

-- A compute run is an immutable snapshot of the computed deferred tax based on temp differences + a resolved rate.
CREATE TABLE IF NOT EXISTS ias12_deferred_tax_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  rate_set_id UUID NOT NULL REFERENCES ias12_tax_rate_sets(id) ON DELETE RESTRICT,
  effective_rate NUMERIC(9,6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'computed' CHECK (status IN ('computed','posted')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ias12_dtr_org_period ON ias12_deferred_tax_runs(organization_id, period_id);

CREATE TABLE IF NOT EXISTS ias12_deferred_tax_run_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES ias12_deferred_tax_runs(id) ON DELETE CASCADE,
  temp_difference_id UUID NOT NULL REFERENCES ias12_temp_differences(id) ON DELETE RESTRICT,
  applied_rate NUMERIC(9,6) NOT NULL,
  computed_tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  diff_type TEXT NOT NULL CHECK (diff_type IN ('DEDUCTIBLE','TAXABLE')),
  recognisable BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, temp_difference_id)
);

CREATE INDEX IF NOT EXISTS idx_ias12_dtrl_run ON ias12_deferred_tax_run_lines(run_id);

-- Roll-forward balances per period (linked to a run)
CREATE TABLE IF NOT EXISTS ias12_deferred_tax_balances (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL REFERENCES ias12_deferred_tax_runs(id) ON DELETE RESTRICT,
  opening_dta NUMERIC(18,2) NOT NULL DEFAULT 0,
  opening_dtl NUMERIC(18,2) NOT NULL DEFAULT 0,
  closing_dta NUMERIC(18,2) NOT NULL DEFAULT 0,
  closing_dtl NUMERIC(18,2) NOT NULL DEFAULT 0,
  movement_dta NUMERIC(18,2) NOT NULL DEFAULT 0,
  movement_dtl NUMERIC(18,2) NOT NULL DEFAULT 0,
  deferred_tax_expense NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, period_id)
);

-- Posting record (idempotent per org+period)
CREATE TABLE IF NOT EXISTS ias12_deferred_tax_postings (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL REFERENCES ias12_deferred_tax_runs(id) ON DELETE RESTRICT,
  journal_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  posted_by UUID REFERENCES users(id),
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, period_id)
);

COMMIT;
