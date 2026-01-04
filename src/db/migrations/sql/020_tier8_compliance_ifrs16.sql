-- Tier 8 (Part A): Compliance - IFRS 16 Leases (minimal backend)
-- Provides: leases + schedule lines + posting links to Tier 1 journals

BEGIN;

CREATE TABLE IF NOT EXISTS leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),

  commencement_date date NOT NULL,
  term_months integer NOT NULL CHECK (term_months > 0),
  payment_amount numeric(18,6) NOT NULL CHECK (payment_amount > 0),
  payments_per_year integer NOT NULL DEFAULT 12 CHECK (payments_per_year IN (1,2,4,12)),
  annual_discount_rate numeric(18,6) NOT NULL DEFAULT 0 CHECK (annual_discount_rate >= 0),

  -- Derived (informational)
  initial_lease_liability numeric(18,6) NULL,
  monthly_depreciation_amount numeric(18,6) NULL,

  -- GL mappings (all point to COA, enforced at application layer to be same org)
  rou_asset_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  lease_liability_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  interest_expense_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  depreciation_expense_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  accumulated_depreciation_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  cash_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),

  created_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(organization_id, code)
);

CREATE TABLE IF NOT EXISTS lease_schedule_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,

  line_no integer NOT NULL CHECK (line_no > 0),
  due_date date NOT NULL,

  opening_balance numeric(18,6) NOT NULL DEFAULT 0,
  payment_amount numeric(18,6) NOT NULL DEFAULT 0,
  interest_amount numeric(18,6) NOT NULL DEFAULT 0,
  principal_amount numeric(18,6) NOT NULL DEFAULT 0,
  closing_balance numeric(18,6) NOT NULL DEFAULT 0,
  depreciation_amount numeric(18,6) NOT NULL DEFAULT 0,

  -- Links to Tier 1 journals (idempotency at line level)
  posted_interest_payment_journal_id uuid NULL REFERENCES journal_entries(id),
  posted_depreciation_journal_id uuid NULL REFERENCES journal_entries(id),

  created_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(lease_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_lease_schedule_lines_lease_due
  ON lease_schedule_lines(lease_id, due_date);

COMMIT;
