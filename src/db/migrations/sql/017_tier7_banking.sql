-- Tier 7: Banking & Reconciliation (minimal backend)
BEGIN;

CREATE TABLE IF NOT EXISTS bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  currency_code text NOT NULL,
  gl_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, code)
);

CREATE TABLE IF NOT EXISTS bank_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  statement_date date NOT NULL,
  opening_balance numeric(18,6) NOT NULL DEFAULT 0,
  closing_balance numeric(18,6) NOT NULL DEFAULT 0,
  created_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, bank_account_id, statement_date)
);

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  txn_date date NOT NULL,
  description text NULL,
  amount numeric(18,6) NOT NULL, -- + inflow, - outflow
  reference text NULL,
  matched boolean NOT NULL DEFAULT false,
  matched_journal_entry_id uuid NULL REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES accounting_periods(id),
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  reconciled_by uuid NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'reconciled' CHECK (status IN ('reconciled','void'))
);

COMMIT;
