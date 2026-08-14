BEGIN;

-- Step 1 hardening: enforce organization consistency in the accounting kernel.
-- Existing single-column FKs guarantee that referenced rows exist; these
-- composite FKs additionally guarantee that they belong to the same tenant.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='account_categories'::regclass AND conname='uq_account_categories_org_id'
  ) THEN
    ALTER TABLE account_categories
      ADD CONSTRAINT uq_account_categories_org_id UNIQUE (organization_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='chart_of_accounts'::regclass AND conname='uq_chart_of_accounts_org_id'
  ) THEN
    ALTER TABLE chart_of_accounts
      ADD CONSTRAINT uq_chart_of_accounts_org_id UNIQUE (organization_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='accounting_periods'::regclass AND conname='uq_accounting_periods_org_id'
  ) THEN
    ALTER TABLE accounting_periods
      ADD CONSTRAINT uq_accounting_periods_org_id UNIQUE (organization_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='journal_entries'::regclass AND conname='uq_journal_entries_org_id'
  ) THEN
    ALTER TABLE journal_entries
      ADD CONSTRAINT uq_journal_entries_org_id UNIQUE (organization_id, id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='chart_of_accounts'::regclass AND conname='fk_coa_category_same_org'
  ) THEN
    ALTER TABLE chart_of_accounts
      ADD CONSTRAINT fk_coa_category_same_org
      FOREIGN KEY (organization_id, category_id)
      REFERENCES account_categories(organization_id, id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='chart_of_accounts'::regclass AND conname='fk_coa_parent_same_org'
  ) THEN
    ALTER TABLE chart_of_accounts
      ADD CONSTRAINT fk_coa_parent_same_org
      FOREIGN KEY (organization_id, parent_account_id)
      REFERENCES chart_of_accounts(organization_id, id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='journal_entries'::regclass AND conname='fk_journal_period_same_org'
  ) THEN
    ALTER TABLE journal_entries
      ADD CONSTRAINT fk_journal_period_same_org
      FOREIGN KEY (organization_id, period_id)
      REFERENCES accounting_periods(organization_id, id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='general_ledger_balances'::regclass AND conname='fk_gl_period_same_org'
  ) THEN
    ALTER TABLE general_ledger_balances
      ADD CONSTRAINT fk_gl_period_same_org
      FOREIGN KEY (organization_id, period_id)
      REFERENCES accounting_periods(organization_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='general_ledger_balances'::regclass AND conname='fk_gl_account_same_org'
  ) THEN
    ALTER TABLE general_ledger_balances
      ADD CONSTRAINT fk_gl_account_same_org
      FOREIGN KEY (organization_id, account_id)
      REFERENCES chart_of_accounts(organization_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='closing_entries'::regclass AND conname='fk_closing_period_same_org'
  ) THEN
    ALTER TABLE closing_entries
      ADD CONSTRAINT fk_closing_period_same_org
      FOREIGN KEY (organization_id, period_id)
      REFERENCES accounting_periods(organization_id, id)
      NOT VALID;
  END IF;

  IF to_regclass('ledger_reconciliation_history') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='ledger_reconciliation_history'::regclass
      AND conname='fk_ledger_reconciliation_period_same_org'
  ) THEN
    ALTER TABLE ledger_reconciliation_history
      ADD CONSTRAINT fk_ledger_reconciliation_period_same_org
      FOREIGN KEY (organization_id, period_id)
      REFERENCES accounting_periods(organization_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;

ALTER TABLE chart_of_accounts VALIDATE CONSTRAINT fk_coa_category_same_org;
ALTER TABLE chart_of_accounts VALIDATE CONSTRAINT fk_coa_parent_same_org;
ALTER TABLE journal_entries VALIDATE CONSTRAINT fk_journal_period_same_org;
ALTER TABLE general_ledger_balances VALIDATE CONSTRAINT fk_gl_period_same_org;
ALTER TABLE general_ledger_balances VALIDATE CONSTRAINT fk_gl_account_same_org;
ALTER TABLE closing_entries VALIDATE CONSTRAINT fk_closing_period_same_org;

DO $$
BEGIN
  IF to_regclass('ledger_reconciliation_history') IS NOT NULL THEN
    ALTER TABLE ledger_reconciliation_history
      VALIDATE CONSTRAINT fk_ledger_reconciliation_period_same_org;
  END IF;
END $$;

-- journal_entry_lines does not carry organization_id, so use the immutable
-- parent journal to enforce account tenancy at the database boundary.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM journal_entry_lines l
      JOIN journal_entries j ON j.id=l.journal_entry_id
      JOIN chart_of_accounts a ON a.id=l.account_id
     WHERE j.organization_id IS DISTINCT FROM a.organization_id
  ) THEN
    RAISE EXCEPTION 'Cannot enable journal-line tenant integrity: cross-organization journal/account references already exist';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_journal_line_tenant_integrity()
RETURNS trigger AS $$
DECLARE
  journal_org UUID;
  account_org UUID;
BEGIN
  SELECT organization_id INTO journal_org
    FROM journal_entries
   WHERE id=NEW.journal_entry_id;

  SELECT organization_id INTO account_org
    FROM chart_of_accounts
   WHERE id=NEW.account_id;

  IF journal_org IS NULL OR account_org IS NULL THEN
    RETURN NEW; -- Existing FKs provide the missing-reference error.
  END IF;

  IF journal_org IS DISTINCT FROM account_org THEN
    RAISE EXCEPTION 'Journal line account must belong to the journal organization'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_line_tenant_integrity ON journal_entry_lines;
CREATE TRIGGER trg_journal_line_tenant_integrity
BEFORE INSERT OR UPDATE OF journal_entry_id, account_id
ON journal_entry_lines
FOR EACH ROW EXECUTE FUNCTION enforce_journal_line_tenant_integrity();

COMMIT;
