BEGIN;

-- Drafts are work-in-progress. Completeness and balancing are enforced when a
-- journal is submitted/posted, not while the user is saving a draft.
ALTER TABLE journal_entry_lines ALTER COLUMN account_id DROP NOT NULL;

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid='journal_entry_lines'::regclass
       AND contype='c'
       AND pg_get_constraintdef(oid) ILIKE '%debit%credit%'
  LOOP
    EXECUTE format('ALTER TABLE journal_entry_lines DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE journal_entry_lines
  ADD CONSTRAINT chk_journal_line_draft_amounts
  CHECK (debit >= 0 AND credit >= 0 AND NOT (debit > 0 AND credit > 0));

COMMIT;
