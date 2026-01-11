-- Tier 7: Banking hardening (statement line identity, match evidence, reconciliation uniqueness)
BEGIN;

-- 1) Bank statement line identity (support repeatable imports)
ALTER TABLE bank_statement_lines
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS line_hash text,
  ADD COLUMN IF NOT EXISTS matched_by uuid NULL REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS matched_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS match_method text NULL,
  ADD COLUMN IF NOT EXISTS match_rule_version text NULL,
  ADD COLUMN IF NOT EXISTS match_reason text NULL;

-- External identity (if provided by a bank feed) must be unique per statement
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_statement_lines_statement_external_id
  ON bank_statement_lines(statement_id, external_id)
  WHERE external_id IS NOT NULL;

-- Deterministic hash identity for non-external-id feeds
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_statement_lines_statement_line_hash
  ON bank_statement_lines(statement_id, line_hash)
  WHERE line_hash IS NOT NULL;

-- 2) Ensure only one active reconciliation per org/account/period
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_reconciliations_active
  ON bank_reconciliations(organization_id, bank_account_id, period_id)
  WHERE status = 'reconciled';

COMMIT;
