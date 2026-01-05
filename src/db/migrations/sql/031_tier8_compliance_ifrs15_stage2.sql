BEGIN;

-- IFRS 15 (Tier 8B) Stage 2: Contract modifications, variable consideration, financing components,
-- contract cost capitalisation, FX rates, and disclosure support.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Extend settings with optional accounts for Stage 2
ALTER TABLE ifrs15_settings
  ADD COLUMN IF NOT EXISTS financing_interest_income_account_id UUID REFERENCES chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS financing_interest_expense_account_id UUID REFERENCES chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS default_cost_asset_account_id UUID REFERENCES chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS default_cost_amort_expense_account_id UUID REFERENCES chart_of_accounts(id);

-- Extend contracts with Stage 2 attributes
ALTER TABLE ifrs15_contracts
  ADD COLUMN IF NOT EXISTS base_transaction_price NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS variable_consideration_estimate NUMERIC(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS variable_consideration_method TEXT CHECK (variable_consideration_method IN ('EXPECTED_VALUE','MOST_LIKELY')),
  ADD COLUMN IF NOT EXISTS variable_consideration_included BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS financing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS financing_annual_rate NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS financing_effective_from DATE,
  ADD COLUMN IF NOT EXISTS financing_effective_to DATE;

UPDATE ifrs15_contracts
SET base_transaction_price = transaction_price
WHERE base_transaction_price IS NULL;

-- Contract modifications (scope/price change handling)
CREATE TABLE IF NOT EXISTS ifrs15_contract_modifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES ifrs15_contracts(id) ON DELETE CASCADE,
  modification_date DATE NOT NULL,
  modification_type TEXT NOT NULL CHECK (modification_type IN ('PRICE_CHANGE','SCOPE_CHANGE','SCOPE_AND_PRICE')),
  new_base_transaction_price NUMERIC(18,6),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','applied','voided')),
  created_by UUID REFERENCES users(id),
  applied_by UUID REFERENCES users(id),
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ifrs15_mods_contract ON ifrs15_contract_modifications(contract_id, modification_date);

-- Reallocation snapshots (audit trail for modifications / variable consideration changes)
CREATE TABLE IF NOT EXISTS ifrs15_reallocation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES ifrs15_contracts(id) ON DELETE CASCADE,
  source_event TEXT NOT NULL CHECK (source_event IN ('MODIFICATION','VARIABLE_CONSIDERATION')),
  source_id UUID,
  effective_date DATE NOT NULL,
  total_ssp NUMERIC(18,6) NOT NULL,
  transaction_price_effective NUMERIC(18,6) NOT NULL,
  snapshot_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ifrs15_realloc_contract_date ON ifrs15_reallocation_snapshots(contract_id, effective_date);

-- Variable consideration estimates (keeps history of estimates/constraints)
CREATE TABLE IF NOT EXISTS ifrs15_variable_consideration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES ifrs15_contracts(id) ON DELETE CASCADE,
  effective_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('EXPECTED_VALUE','MOST_LIKELY')),
  estimate_amount NUMERIC(18,6) NOT NULL,
  included BOOLEAN NOT NULL DEFAULT FALSE,
  rationale TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ifrs15_var_cons_contract_date ON ifrs15_variable_consideration(contract_id, effective_date);

-- Financing terms (significant financing component parameters)
CREATE TABLE IF NOT EXISTS ifrs15_financing_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES ifrs15_contracts(id) ON DELETE CASCADE,
  annual_rate NUMERIC(18,6) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contract_id, effective_from)
);

-- Capitalised contract costs (acquisition/fulfilment)
CREATE TABLE IF NOT EXISTS ifrs15_capitalised_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES ifrs15_contracts(id) ON DELETE CASCADE,
  cost_type TEXT NOT NULL CHECK (cost_type IN ('ACQUISITION','FULFILMENT')),
  description TEXT,
  amount NUMERIC(18,6) NOT NULL,
  asset_account_id UUID REFERENCES chart_of_accounts(id),
  amort_expense_account_id UUID REFERENCES chart_of_accounts(id),
  amort_method TEXT NOT NULL DEFAULT 'STRAIGHT_LINE' CHECK (amort_method IN ('STRAIGHT_LINE')),
  amort_start_date DATE NOT NULL,
  amort_end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','fully_amortised','voided')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ifrs15_costs_contract ON ifrs15_capitalised_costs(contract_id);

CREATE TABLE IF NOT EXISTS ifrs15_cost_amort_schedule_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cost_id UUID NOT NULL REFERENCES ifrs15_capitalised_costs(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES ifrs15_contracts(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id),
  recognition_date DATE NOT NULL,
  scheduled_amount NUMERIC(18,6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','posted','voided')),
  posted_journal_id UUID REFERENCES journal_entries(id),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(cost_id, period_id)
);

CREATE INDEX IF NOT EXISTS idx_ifrs15_cost_sched_contract_period ON ifrs15_cost_amort_schedule_lines(contract_id, period_id);

-- FX rates to functional currency (optional; can be used by reporting/posting if needed)
CREATE TABLE IF NOT EXISTS ifrs15_fx_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  currency_code TEXT NOT NULL,
  rate_date DATE NOT NULL,
  rate_to_functional NUMERIC(18,8) NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, currency_code, rate_date)
);

COMMIT;
