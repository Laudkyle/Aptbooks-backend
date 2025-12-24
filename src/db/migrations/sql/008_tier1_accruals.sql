-- 007_tier1_accruals.sql
-- Tier 1: Accrual rules + runs + journal linkage (kernel-owned)
-- Corrected + idempotent

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================
-- Accrual rules (templates)
-- =========================
CREATE TABLE IF NOT EXISTS accrual_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  code TEXT NOT NULL,
  name TEXT NOT NULL,

  rule_type TEXT NOT NULL CHECK (rule_type IN ('REVERSING','RECURRING','DEFERRAL','DERIVED')),
  frequency TEXT NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','PERIOD_END','ON_DEMAND')),

  -- For REVERSING rules (and optionally others)
  auto_reverse BOOLEAN NOT NULL DEFAULT FALSE,
  reverse_timing TEXT CHECK (reverse_timing IS NULL OR reverse_timing IN ('NEXT_PERIOD_START')),

  start_date DATE,
  end_date DATE,

  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id, code)
);

-- Required flag for period-close gating
ALTER TABLE accrual_rules
  ADD COLUMN IF NOT EXISTS is_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_accrual_rules_required
  ON accrual_rules(organization_id, status, frequency, is_required);

CREATE INDEX IF NOT EXISTS idx_accrual_rules_org_status
  ON accrual_rules(organization_id, status);

-- =====================================
-- Rule lines (templated journal lines)
-- =====================================
CREATE TABLE IF NOT EXISTS accrual_rule_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  accrual_rule_id UUID NOT NULL REFERENCES accrual_rules(id) ON DELETE CASCADE,
  line_no INT NOT NULL,

  account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  dc TEXT NOT NULL CHECK (dc IN ('debit','credit')),

  amount_type TEXT NOT NULL DEFAULT 'fixed' CHECK (amount_type IN ('fixed')),
  amount_value NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount_value > 0),

  description TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (accrual_rule_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_accrual_rule_lines_rule
  ON accrual_rule_lines(accrual_rule_id);

-- ====================
-- Execution tracking
-- ====================
CREATE TABLE IF NOT EXISTS accrual_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  accrual_rule_id UUID NOT NULL REFERENCES accrual_rules(id) ON DELETE CASCADE,

  -- v1: always set when posting (open period for date)
  period_id UUID REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  as_of_date DATE NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','posted','reversed','failed','skipped')),

  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Failure tracking (run-level, not rule-level)
  error TEXT,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  failure_count INT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency / concurrency safety: run once per (org, rule, period, date)
CREATE UNIQUE INDEX IF NOT EXISTS uq_accrual_runs_once
  ON accrual_runs(organization_id, accrual_rule_id, period_id, as_of_date);

CREATE INDEX IF NOT EXISTS idx_accrual_runs_org_rule_date
  ON accrual_runs(organization_id, accrual_rule_id, as_of_date);

CREATE INDEX IF NOT EXISTS idx_accrual_runs_period
  ON accrual_runs(organization_id, period_id, as_of_date);

-- ==================================
-- Link runs to journals (traceability)
-- ==================================
CREATE TABLE IF NOT EXISTS accrual_run_postings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  accrual_run_id UUID NOT NULL REFERENCES accrual_runs(id) ON DELETE CASCADE,

  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,

  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Reversal failure persistence (do NOT mark run failed when reversal fails)
  reversal_failed_at TIMESTAMPTZ,
  reversal_failure_reason TEXT,
  reversal_failure_count INT NOT NULL DEFAULT 0,

  UNIQUE (accrual_run_id)
);

-- Backwards-safe: if table existed before these columns, ensure they exist
ALTER TABLE accrual_run_postings
  ADD COLUMN IF NOT EXISTS reversal_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversal_failure_count INT NOT NULL DEFAULT 0;

-- ==========================
-- Optional: deferral schedule
-- ==========================
CREATE TABLE IF NOT EXISTS accrual_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  accrual_rule_id UUID NOT NULL REFERENCES accrual_rules(id) ON DELETE CASCADE,

  total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount >= 0),
  remaining_amount NUMERIC(18,2) NOT NULL CHECK (remaining_amount >= 0),

  recognition_method TEXT NOT NULL DEFAULT 'straight_line'
    CHECK (recognition_method IN ('straight_line')),
  period_count INT NOT NULL CHECK (period_count > 0),
  start_period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','complete','inactive')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (accrual_rule_id)
);
