-- Reporting Stage 1: Production-grade statement engine primitives
--
-- This migration strengthens the Tier 6 reporting schema so financial statements can be
-- built from statement templates (not hard-coded account_type groupings).

BEGIN;

-- 1) statement_lines: hierarchy + presentation metadata
ALTER TABLE statement_lines
  ADD COLUMN IF NOT EXISTS parent_line_id UUID NULL REFERENCES statement_lines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_visible BOOLEAN NOT NULL DEFAULT TRUE,
  -- Optional sign handling for statement presentation. Values: 'debit','credit','auto'
  ADD COLUMN IF NOT EXISTS dr_cr_normal TEXT NULL CHECK (dr_cr_normal IN ('debit','credit','auto')),
  ADD COLUMN IF NOT EXISTS section_code TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_statement_lines_parent
  ON statement_lines(parent_line_id);

-- 2) Many-to-many mapping (line -> accounts)
CREATE TABLE IF NOT EXISTS statement_line_accounts (
  line_id UUID NOT NULL REFERENCES statement_lines(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  -- Optional overrides for complex lines
  weight NUMERIC(18,6) NOT NULL DEFAULT 1,
  sign_override TEXT NULL CHECK (sign_override IN ('debit','credit')),
  PRIMARY KEY (line_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_statement_line_accounts_account
  ON statement_line_accounts(account_id);

COMMIT;
