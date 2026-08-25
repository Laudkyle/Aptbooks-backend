BEGIN;

-- ============================================================================
-- Banking master data and bank-statement control evidence
-- ============================================================================
ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS bank_name TEXT,
  ADD COLUMN IF NOT EXISTS branch_name TEXT,
  ADD COLUMN IF NOT EXISTS account_number_masked TEXT,
  ADD COLUMN IF NOT EXISTS swift_bic TEXT,
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS minimum_balance NUMERIC(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overdraft_limit NUMERIC(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconciliation_tolerance NUMERIC(18,6) NOT NULL DEFAULT 0.01,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_account_type_chk;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_account_type_chk
  CHECK (account_type IN ('current','savings','money_market','mobile_money','other'));
ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_minimum_balance_chk;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_minimum_balance_chk CHECK (minimum_balance >= 0);
ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_overdraft_limit_chk;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_overdraft_limit_chk CHECK (overdraft_limit >= 0);
ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_reconciliation_tolerance_chk;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_reconciliation_tolerance_chk CHECK (reconciliation_tolerance >= 0);

ALTER TABLE bank_statements
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS external_statement_id TEXT,
  ADD COLUMN IF NOT EXISTS import_checksum TEXT,
  ADD COLUMN IF NOT EXISTS line_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS control_difference NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE bank_statements DROP CONSTRAINT IF EXISTS bank_statements_status_chk;
ALTER TABLE bank_statements ADD CONSTRAINT bank_statements_status_chk
  CHECK (status IN ('draft','validated','locked'));
ALTER TABLE bank_statements DROP CONSTRAINT IF EXISTS bank_statements_source_type_chk;
ALTER TABLE bank_statements ADD CONSTRAINT bank_statements_source_type_chk
  CHECK (source_type IN ('manual','csv','bank_feed','api'));
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_statements_external_identity
  ON bank_statements(organization_id, bank_account_id, external_statement_id)
  WHERE external_statement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_statements_org_status_date
  ON bank_statements(organization_id, status, statement_date DESC);

ALTER TABLE bank_reconciliations
  ADD COLUMN IF NOT EXISTS statement_id UUID REFERENCES bank_statements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS statement_balance NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS ledger_balance NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS difference NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS unmatched_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tolerance_amount NUMERIC(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS control_json JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_statement
  ON bank_reconciliations(organization_id, statement_id)
  WHERE statement_id IS NOT NULL;

-- ============================================================================
-- Treasury maker/checker, posting evidence, and lifecycle timestamps
-- ============================================================================
CREATE TABLE IF NOT EXISTS treasury_controls (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enforce_maker_checker BOOLEAN NOT NULL DEFAULT TRUE,
  require_execution_by_different_user BOOLEAN NOT NULL DEFAULT TRUE,
  require_payment_run_approval BOOLEAN NOT NULL DEFAULT TRUE,
  require_transfer_approval BOOLEAN NOT NULL DEFAULT TRUE,
  default_reconciliation_tolerance NUMERIC(18,6) NOT NULL DEFAULT 0.01 CHECK (default_reconciliation_tolerance >= 0),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE treasury_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_controls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aptbooks_tenant_isolation ON treasury_controls;
CREATE POLICY aptbooks_tenant_isolation ON treasury_controls
  USING (organization_id = aptbooks_current_organization_id())
  WITH CHECK (organization_id = aptbooks_current_organization_id());

-- A reversed payment run is an immutable executed instruction whose posted journal was
-- subsequently reversed through a controlled instrument lifecycle (for example, a
-- bounced/voided cheque).  Keep the original execution evidence and append reversal
-- provenance instead of mutating/deleting financial history.
ALTER TABLE payment_runs DROP CONSTRAINT IF EXISTS payment_runs_status_check;
ALTER TABLE payment_runs
  ADD CONSTRAINT payment_runs_status_check
  CHECK (status IN ('draft','submitted','approved','executed','reversed','cancelled'));

ALTER TABLE payment_runs
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

-- One payment run may have only one active physical cheque at a time. Historical
-- voided/bounced instruments remain linked for audit evidence while a replacement
-- cheque can be issued through the controlled lifecycle.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM cheques
     WHERE payment_run_id IS NOT NULL AND status NOT IN ('voided','bounced')
     GROUP BY organization_id, payment_run_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migration 165: multiple active cheques reference the same payment run; resolve duplicate instrument links before enabling treasury controls';
  END IF;
END $$;
DROP INDEX IF EXISTS uq_cheques_org_payment_run;
CREATE UNIQUE INDEX uq_cheques_org_payment_run
  ON cheques(organization_id, payment_run_id)
  WHERE payment_run_id IS NOT NULL AND status NOT IN ('voided','bounced');

ALTER TABLE payment_runs
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS control_total NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS control_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE bank_transfers
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_currency_code TEXT,
  ADD COLUMN IF NOT EXISTS destination_currency_code TEXT,
  ADD COLUMN IF NOT EXISTS control_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE payment_approval_batches
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE cheques
  ADD COLUMN IF NOT EXISTS issued_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleared_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS bounced_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounce_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_runs_org_execution_control
  ON payment_runs(organization_id, status, execution_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_transfers_org_transfer_control
  ON bank_transfers(organization_id, status, transfer_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cheques_org_lifecycle
  ON cheques(organization_id, bank_account_id, status, issue_date);

COMMIT;
