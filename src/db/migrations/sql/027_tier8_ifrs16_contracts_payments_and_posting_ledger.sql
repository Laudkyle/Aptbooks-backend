-- Tier 8 (Part A): IFRS 16 Leases - Contract structure, payments, modifications, and posting ledger
-- Adds optional/extension tables to make IFRS16 production-grade without breaking existing APIs.

BEGIN;

-- One-to-one extension table for contract metadata.
CREATE TABLE IF NOT EXISTS lease_contracts (
  lease_id uuid PRIMARY KEY REFERENCES leases(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  counterparty_partner_id uuid NULL REFERENCES business_partners(id) ON DELETE RESTRICT,
  contract_reference text NULL,
  currency_code char(3) NOT NULL DEFAULT 'USD' REFERENCES currencies(code),

  payment_timing text NOT NULL DEFAULT 'arrears' CHECK (payment_timing IN ('arrears','advance')),
  indexation text NULL, -- e.g. 'CPI', 'LIBOR', 'custom'
  has_purchase_option boolean NOT NULL DEFAULT FALSE,
  has_extension_option boolean NOT NULL DEFAULT FALSE,
  has_termination_option boolean NOT NULL DEFAULT FALSE,
  residual_value_guarantee numeric(18,6) NULL,
  initial_direct_costs numeric(18,6) NULL,
  lease_incentives numeric(18,6) NULL,
  restoration_provision numeric(18,6) NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_lease_contracts_org ON lease_contracts(organization_id);

-- One-to-many assets under a lease.
CREATE TABLE IF NOT EXISTS lease_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  asset_code text NULL,
  description text NOT NULL,
  asset_class text NULL,
  useful_life_months integer NULL CHECK (useful_life_months IS NULL OR useful_life_months > 0),

  rou_cost numeric(18,6) NULL,
  is_primary boolean NOT NULL DEFAULT FALSE,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (lease_id, asset_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lease_assets_one_primary
  ON lease_assets(lease_id) WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS idx_lease_assets_lease ON lease_assets(lease_id);

-- Actual and planned payments. Schedule lines remain the amortisation model.
-- Payments allow reconciliation of cash vs schedule and support non-level cash flows.
CREATE TABLE IF NOT EXISTS lease_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  due_date date NOT NULL,
  amount numeric(18,6) NOT NULL,
  payment_type text NOT NULL DEFAULT 'fixed' CHECK (payment_type IN ('fixed','variable','fee','incentive','restoration','other')),
  is_actual boolean NOT NULL DEFAULT FALSE,
  paid_date date NULL,
  reference text NULL,

  schedule_line_id uuid NULL REFERENCES lease_schedule_lines(id) ON DELETE SET NULL,

  created_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (lease_id, due_date, payment_type, is_actual, reference)
);

CREATE INDEX IF NOT EXISTS idx_lease_payments_lease_due ON lease_payments(lease_id, due_date);

-- Modifications / remeasurements - captures intent and parameter deltas.
CREATE TABLE IF NOT EXISTS lease_modifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  effective_date date NOT NULL,
  reason text NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','applied','voided')),

  new_term_months integer NULL CHECK (new_term_months IS NULL OR new_term_months > 0),
  new_payment_amount numeric(18,6) NULL CHECK (new_payment_amount IS NULL OR new_payment_amount > 0),
  new_payments_per_year integer NULL CHECK (new_payments_per_year IS NULL OR new_payments_per_year IN (1,2,4,12)),
  new_annual_discount_rate numeric(18,6) NULL CHECK (new_annual_discount_rate IS NULL OR new_annual_discount_rate >= 0),
  new_payment_timing text NULL CHECK (new_payment_timing IS NULL OR new_payment_timing IN ('arrears','advance')),

  applied_at timestamptz NULL,
  applied_by uuid NULL REFERENCES users(id),

  created_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_modifications_lease_effective
  ON lease_modifications(lease_id, effective_date);

-- Posting ledger for IFRS16.
-- This is a lightweight audit/control surface that complements Tier 1 journal idempotency.
CREATE TABLE IF NOT EXISTS lease_posting_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  schedule_line_id uuid NULL REFERENCES lease_schedule_lines(id) ON DELETE CASCADE,
  modification_id uuid NULL REFERENCES lease_modifications(id) ON DELETE CASCADE,

  action text NOT NULL CHECK (action IN ('initial_recognition','interest_payment','depreciation','modification','termination')),
  idempotency_key text NOT NULL,
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,

  created_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, idempotency_key),
  UNIQUE (lease_id, action, schedule_line_id, modification_id)
);

CREATE INDEX IF NOT EXISTS idx_lease_posting_ledger_lease ON lease_posting_ledger(lease_id);

COMMIT;
