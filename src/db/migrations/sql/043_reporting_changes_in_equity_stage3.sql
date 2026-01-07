-- 043_reporting_changes_in_equity_stage3.sql
-- Stage 3: Statement of Changes in Equity (IAS 1) support

BEGIN;

-- Extend existing CHECK constraints for statement types to include changes_in_equity.
DO $$
DECLARE cname text;
BEGIN
  SELECT c.conname INTO cname
  FROM pg_constraint c
  WHERE c.conrelid = 'statement_templates'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%statement_type%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE statement_templates DROP CONSTRAINT %I', cname);
  END IF;
END$$;

ALTER TABLE statement_templates
  ADD CONSTRAINT statement_templates_statement_type_check
  CHECK (statement_type IN ('income_statement','balance_sheet','cash_flow','trial_balance','changes_in_equity','custom'));

DO $$
DECLARE cname text;
BEGIN
  SELECT c.conname INTO cname
  FROM pg_constraint c
  WHERE c.conrelid = 'financial_statements'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%statement_type%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE financial_statements DROP CONSTRAINT %I', cname);
  END IF;
END$$;

ALTER TABLE financial_statements
  ADD CONSTRAINT financial_statements_statement_type_check
  CHECK (statement_type IN ('income_statement','balance_sheet','cash_flow','trial_balance','changes_in_equity','custom'));

-- Org-level settings to enable consistent equity reporting.
CREATE TABLE IF NOT EXISTS reporting_equity_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  retained_earnings_account_id uuid NULL REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Standard movement types (extensible).
CREATE TABLE IF NOT EXISTS equity_movement_types (
  code text PRIMARY KEY,
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 100
);

INSERT INTO equity_movement_types(code, name, sort_order) VALUES
  ('net_income', 'Net income / (loss)', 10),
  ('dividends', 'Dividends / distributions', 20),
  ('contributions', 'Capital contributions', 30),
  ('oci', 'Other comprehensive income', 40),
  ('other', 'Other equity movements', 90)
ON CONFLICT (code) DO NOTHING;

-- Map equity accounts to movement categories (optional refinement by journal entry type).
CREATE TABLE IF NOT EXISTS reporting_equity_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
  movement_code text NOT NULL REFERENCES equity_movement_types(code),
  journal_entry_type_code text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, account_id, movement_code, journal_entry_type_code)
);

CREATE INDEX IF NOT EXISTS idx_reporting_equity_mappings_org_account
  ON reporting_equity_mappings(organization_id, account_id);

COMMIT;
