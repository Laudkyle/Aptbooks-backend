
BEGIN;

CREATE TABLE IF NOT EXISTS payment_approval_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_no text NOT NULL,
  name text NOT NULL,
  scheduled_date date NULL,
  notes text NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','cancelled')),
  approved_by_user_id uuid NULL REFERENCES users(id),
  cancelled_reason text NULL,
  created_by_user_id uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, batch_no)
);

CREATE TABLE IF NOT EXISTS payment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  execution_date date NOT NULL,
  currency_code text NOT NULL,
  memo text NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','executed','cancelled')),
  approval_batch_id uuid NULL REFERENCES payment_approval_batches(id) ON DELETE SET NULL,
  period_id uuid NULL REFERENCES accounting_periods(id) ON DELETE SET NULL,
  journal_entry_id uuid NULL REFERENCES journal_entries(id) ON DELETE SET NULL,
  approved_by_user_id uuid NULL REFERENCES users(id),
  executed_by_user_id uuid NULL REFERENCES users(id),
  cancelled_reason text NULL,
  created_by_user_id uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, code)
);

CREATE TABLE IF NOT EXISTS payment_run_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_run_id uuid NOT NULL REFERENCES payment_runs(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  partner_id uuid NULL REFERENCES business_partners(id) ON DELETE SET NULL,
  payee_name text NULL,
  source_type text NULL,
  source_id uuid NULL,
  offset_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  description text NULL,
  amount numeric(18,6) NOT NULL CHECK (amount > 0),
  currency_code text NULL,
  dimensions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_run_id, line_no)
);

CREATE TABLE IF NOT EXISTS bank_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  from_bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  to_bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  transfer_date date NOT NULL,
  amount numeric(18,6) NOT NULL CHECK (amount > 0),
  fee_amount numeric(18,6) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  fee_account_id uuid NULL REFERENCES chart_of_accounts(id),
  reference text NULL,
  memo text NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','posted','cancelled')),
  approval_batch_id uuid NULL REFERENCES payment_approval_batches(id) ON DELETE SET NULL,
  period_id uuid NULL REFERENCES accounting_periods(id) ON DELETE SET NULL,
  journal_entry_id uuid NULL REFERENCES journal_entries(id) ON DELETE SET NULL,
  approved_by_user_id uuid NULL REFERENCES users(id),
  posted_by_user_id uuid NULL REFERENCES users(id),
  cancelled_reason text NULL,
  created_by_user_id uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, code),
  CHECK (from_bank_account_id <> to_bank_account_id)
);

CREATE TABLE IF NOT EXISTS payment_approval_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES payment_approval_batches(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('payment_run','bank_transfer')),
  item_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, item_type, item_id)
);

CREATE TABLE IF NOT EXISTS cheques (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  cheque_no text NOT NULL,
  payee_name text NULL,
  issue_date date NULL,
  amount numeric(18,6) NULL CHECK (amount IS NULL OR amount > 0),
  currency_code text NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','issued','cleared','voided','bounced')),
  memo text NULL,
  cleared_date date NULL,
  payment_run_id uuid NULL REFERENCES payment_runs(id) ON DELETE SET NULL,
  journal_entry_id uuid NULL REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by_user_id uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, bank_account_id, cheque_no)
);

CREATE TABLE IF NOT EXISTS cash_forecast_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  horizon_days int NOT NULL CHECK (horizon_days > 0),
  assumptions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_runs_org_status_date ON payment_runs(organization_id, status, execution_date);
CREATE INDEX IF NOT EXISTS idx_payment_run_lines_run ON payment_run_lines(payment_run_id);
CREATE INDEX IF NOT EXISTS idx_bank_transfers_org_status_date ON bank_transfers(organization_id, status, transfer_date);
CREATE INDEX IF NOT EXISTS idx_payment_approval_batch_items_batch ON payment_approval_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_cheques_org_status_issue ON cheques(organization_id, status, issue_date);
CREATE INDEX IF NOT EXISTS idx_cash_forecast_snapshots_org_created ON cash_forecast_snapshots(organization_id, created_at DESC);

COMMIT;
