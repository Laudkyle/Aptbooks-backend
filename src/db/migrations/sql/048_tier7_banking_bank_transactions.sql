-- Tier 7: Banking (transaction ledger)
-- Adds a canonical bank_transactions table used by reconciliations and reporting.
-- This is additive and safe for existing databases.

BEGIN;

CREATE TABLE IF NOT EXISTS bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  txn_date date NOT NULL,
  amount numeric(18,6) NOT NULL, -- + inflow, - outflow
  description text NULL,
  reference text NULL,

  -- Provenance / linkage
  source_type text NULL CHECK (source_type IN ('statement_line','journal','manual','import')),
  source_id uuid NULL,
  statement_line_id uuid NULL REFERENCES bank_statement_lines(id) ON DELETE SET NULL,
  journal_entry_id uuid NULL REFERENCES journal_entries(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL REFERENCES users(id),

  -- Optional dedupe key for imports/integrations
  external_id text NULL,

  UNIQUE(organization_id, bank_account_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_org_account_date
  ON bank_transactions(organization_id, bank_account_id, txn_date);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_statement_line
  ON bank_transactions(statement_line_id);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_journal
  ON bank_transactions(journal_entry_id);

COMMIT;
