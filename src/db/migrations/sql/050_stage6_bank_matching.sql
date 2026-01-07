-- 050_stage6_bank_matching.sql
-- Stage 6: Explicit bank matching + reconciliation locks

BEGIN;

CREATE TABLE IF NOT EXISTS bank_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_statement_line_id UUID NOT NULL REFERENCES bank_statement_lines(id) ON DELETE CASCADE,
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  matched_amount NUMERIC(18,6) NOT NULL,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(bank_statement_line_id)
);

-- Lock reconciliations per bank account + period
ALTER TABLE bank_reconciliations
  ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
