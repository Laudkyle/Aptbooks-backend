BEGIN;

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entries_updated_by ON journal_entries(updated_by);

COMMIT;
