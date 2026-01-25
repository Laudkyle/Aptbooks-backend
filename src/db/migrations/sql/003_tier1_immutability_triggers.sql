CREATE OR REPLACE FUNCTION prevent_locked_journal_mutation()
RETURNS trigger AS $$
DECLARE
  je_status TEXT;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    -- Blocking updates to posted/voided journals
    IF OLD.status IN ('posted','voided') THEN
      RAISE EXCEPTION 'Cannot modify journal_entries in status %', OLD.status
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'journal_entry_lines' THEN
    SELECT status INTO je_status FROM journal_entries WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);
    IF je_status IN ('posted','voided') THEN
      RAISE EXCEPTION 'Cannot modify journal_entry_lines for journal in status %', je_status
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  -- journal_entries: prevent UPDATE/DELETE when status posted/voided
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_journal_entries_update') THEN
    CREATE TRIGGER trg_prevent_journal_entries_update
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION prevent_locked_journal_mutation();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_journal_entries_delete') THEN
    CREATE TRIGGER trg_prevent_journal_entries_delete
    BEFORE DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION prevent_locked_journal_mutation();
  END IF;

  -- journal_entry_lines: prevent UPDATE/DELETE if parent journal posted/voided
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_journal_lines_update') THEN
    CREATE TRIGGER trg_prevent_journal_lines_update
    BEFORE UPDATE ON journal_entry_lines
    FOR EACH ROW EXECUTE FUNCTION prevent_locked_journal_mutation();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_journal_lines_delete') THEN
    CREATE TRIGGER trg_prevent_journal_lines_delete
    BEFORE DELETE ON journal_entry_lines
    FOR EACH ROW EXECUTE FUNCTION prevent_locked_journal_mutation();
  END IF;
END $$;
