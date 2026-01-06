-- 036_tier8_compliance_ifrs9_stage1.sql

-- IFRS 9 (Stage 1): Simplified approach ECL for trade receivables
-- - ECL models with ageing buckets + loss rates
-- - Period runs (compute -> finalize -> post -> reverse)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS ifrs9_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  impairment_expense_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  loss_allowance_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  default_model_id UUID,
  rounding_decimals INT NOT NULL DEFAULT 2 CHECK (rounding_decimals BETWEEN 0 AND 6),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ifrs9_ecl_models (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

ALTER TABLE ifrs9_settings
  DROP CONSTRAINT IF EXISTS ifrs9_settings_default_model_fk;
ALTER TABLE ifrs9_settings
  ADD CONSTRAINT ifrs9_settings_default_model_fk
  FOREIGN KEY (default_model_id) REFERENCES ifrs9_ecl_models(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ifrs9_ecl_buckets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  model_id UUID NOT NULL REFERENCES ifrs9_ecl_models(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  days_past_due_from INT NOT NULL CHECK (days_past_due_from >= 0),
  days_past_due_to INT CHECK (days_past_due_to IS NULL OR days_past_due_to >= 0),
  loss_rate NUMERIC(10,6) NOT NULL CHECK (loss_rate >= 0 AND loss_rate <= 1),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_id, label),
  CHECK (days_past_due_to IS NULL OR days_past_due_to >= days_past_due_from)
);

CREATE INDEX IF NOT EXISTS idx_ifrs9_ecl_buckets_model_from ON ifrs9_ecl_buckets(model_id, days_past_due_from);

CREATE TABLE IF NOT EXISTS ifrs9_ecl_runs (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  model_id UUID NOT NULL REFERENCES ifrs9_ecl_models(id) ON DELETE RESTRICT,
  as_of_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'computed' CHECK (status IN ('computed','finalized','posted','reversed')),

  total_exposure NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_ecl NUMERIC(18,2) NOT NULL DEFAULT 0,
  prior_posted_ecl NUMERIC(18,2) NOT NULL DEFAULT 0,
  delta_allowance NUMERIC(18,2) NOT NULL DEFAULT 0,

  memo TEXT,

  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,

  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  posted_at TIMESTAMPTZ,
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,

  reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ifrs9_runs_org_period ON ifrs9_ecl_runs(organization_id, period_id);
CREATE INDEX IF NOT EXISTS idx_ifrs9_runs_org_status ON ifrs9_ecl_runs(organization_id, status);

CREATE TABLE IF NOT EXISTS ifrs9_ecl_run_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES ifrs9_ecl_runs(id) ON DELETE CASCADE,

  customer_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,
  bucket_id UUID NOT NULL REFERENCES ifrs9_ecl_buckets(id) ON DELETE RESTRICT,
  bucket_label TEXT NOT NULL,
  days_past_due_from INT NOT NULL,
  days_past_due_to INT,
  loss_rate NUMERIC(10,6) NOT NULL,

  invoice_count INT NOT NULL DEFAULT 0,
  exposure_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ecl_amount NUMERIC(18,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ifrs9_run_lines_run ON ifrs9_ecl_run_lines(run_id);
CREATE INDEX IF NOT EXISTS idx_ifrs9_run_lines_customer ON ifrs9_ecl_run_lines(customer_id);

CREATE TABLE IF NOT EXISTS ifrs9_posting_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES ifrs9_ecl_runs(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  UNIQUE (organization_id, idempotency_key)
);
