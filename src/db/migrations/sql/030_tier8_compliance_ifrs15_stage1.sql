BEGIN;

-- IFRS 15 (Tier 8B) Stage 1: Core contract/obligation, deterministic allocation, schedules, posting ledger, settings, and audit events.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Settings per organization (posting mappings)
CREATE TABLE IF NOT EXISTS ifrs15_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  revenue_account_id UUID REFERENCES chart_of_accounts(id),
  contract_asset_account_id UUID REFERENCES chart_of_accounts(id),
  contract_liability_account_id UUID REFERENCES chart_of_accounts(id),
  default_billing_account_id UUID REFERENCES chart_of_accounts(id),
  rounding_decimals INT NOT NULL DEFAULT 2 CHECK (rounding_decimals BETWEEN 0 AND 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Contracts
CREATE TABLE IF NOT EXISTS ifrs15_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Customer is modelled as a business_partner with type='customer' (see migration 005).
  business_partner_id UUID REFERENCES business_partners(id),
  code TEXT NOT NULL,
  contract_date DATE NOT NULL,
  currency_code TEXT,
  transaction_price NUMERIC(18,6) NOT NULL DEFAULT 0,
  billing_policy TEXT NOT NULL DEFAULT 'UPFRONT' CHECK (billing_policy IN ('UPFRONT','AS_RECOGNIZED','NONE')),
  billing_account_id UUID REFERENCES chart_of_accounts(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','cancelled')),
  start_date DATE,
  end_date DATE,
  memo TEXT,
  created_by UUID REFERENCES users(id),
  activated_by UUID REFERENCES users(id),
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_ifrs15_contracts_org_status ON ifrs15_contracts(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_ifrs15_contracts_bp ON ifrs15_contracts(business_partner_id);

-- Performance obligations
CREATE TABLE IF NOT EXISTS ifrs15_performance_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES ifrs15_contracts(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  obligation_type TEXT NOT NULL CHECK (obligation_type IN ('POINT_IN_TIME','OVER_TIME')),
  satisfaction_method TEXT NOT NULL CHECK (satisfaction_method IN ('TIME','OUTPUT')),
  standalone_selling_price NUMERIC(18,6) NOT NULL,
  allocated_amount NUMERIC(18,6),
  allocated_ratio NUMERIC(18,6),
  -- For POINT_IN_TIME
  satisfaction_date DATE,
  -- For OVER_TIME
  start_date DATE,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','satisfied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ifrs15_obligations_contract ON ifrs15_performance_obligations(contract_id);

-- Allocation snapshot per activation
CREATE TABLE IF NOT EXISTS ifrs15_allocation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES ifrs15_contracts(id) ON DELETE CASCADE,
  activated_at TIMESTAMPTZ NOT NULL,
  total_ssp NUMERIC(18,6) NOT NULL,
  transaction_price NUMERIC(18,6) NOT NULL,
  snapshot_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Recognition schedule lines per obligation and period
CREATE TABLE IF NOT EXISTS ifrs15_recognition_schedule_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES ifrs15_contracts(id) ON DELETE CASCADE,
  obligation_id UUID NOT NULL REFERENCES ifrs15_performance_obligations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id),
  recognition_date DATE NOT NULL,
  scheduled_amount NUMERIC(18,6) NOT NULL,
  recognized_amount NUMERIC(18,6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','posted','voided')),
  posted_journal_id UUID REFERENCES journal_entries(id),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (obligation_id, period_id)
);

CREATE INDEX IF NOT EXISTS idx_ifrs15_sched_contract_period ON ifrs15_recognition_schedule_lines(contract_id, period_id);
CREATE INDEX IF NOT EXISTS idx_ifrs15_sched_org_period ON ifrs15_recognition_schedule_lines(organization_id, period_id);

-- Posting ledger for audit/reconciliation
CREATE TABLE IF NOT EXISTS ifrs15_posting_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id UUID REFERENCES ifrs15_contracts(id) ON DELETE SET NULL,
  period_id UUID REFERENCES accounting_periods(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  journal_id UUID REFERENCES journal_entries(id),
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id UUID REFERENCES users(id),
  meta JSONB,
  UNIQUE (organization_id, idempotency_key)
);

-- Audit events
CREATE TABLE IF NOT EXISTS ifrs15_contract_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id UUID REFERENCES ifrs15_contracts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_ifrs15_events_contract ON ifrs15_contract_events(contract_id, occurred_at);

COMMIT;
