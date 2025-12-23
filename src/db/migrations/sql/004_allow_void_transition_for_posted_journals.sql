-- Allow only a strict status transition from posted -> voided on journal_entries
-- while keeping journals and lines immutable otherwise.

CREATE OR REPLACE FUNCTION prevent_locked_journal_mutation()
RETURNS trigger AS $$
DECLARE
  je_status TEXT;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN

    -- Never allow deleting posted/voided journals
    IF TG_OP = 'DELETE' AND OLD.status IN ('posted','voided') THEN
      RAISE EXCEPTION 'Cannot delete journal_entries in status %', OLD.status
        USING ERRCODE = '55000';
    END IF;

    -- For UPDATE rules:
    IF TG_OP = 'UPDATE' THEN

      -- Once voided, never modify again
      IF OLD.status = 'voided' THEN
        RAISE EXCEPTION 'Cannot modify journal_entries in status voided'
          USING ERRCODE = '55000';
      END IF;

      -- If posted, allow ONLY posted -> voided, and only void fields may change
      IF OLD.status = 'posted' THEN
        IF NEW.status = 'voided' THEN
          -- Ensure all non-void fields remain identical
          IF NEW.organization_id = OLD.organization_id
             AND NEW.entry_no = OLD.entry_no
             AND NEW.journal_entry_type_id = OLD.journal_entry_type_id
             AND NEW.period_id = OLD.period_id
             AND NEW.entry_date = OLD.entry_date
             AND COALESCE(NEW.memo,'') = COALESCE(OLD.memo,'')
             AND COALESCE(NEW.posted_at, OLD.posted_at) = OLD.posted_at
             AND COALESCE(NEW.posted_by, OLD.posted_by) = OLD.posted_by
             AND COALESCE(NEW.idempotency_key,'') = COALESCE(OLD.idempotency_key,'')
             AND NEW.created_at = OLD.created_at
          THEN
            -- Allowed changes: voided_at, voided_by, void_reason, status, updated_at
            RETURN NEW;
          END IF;

          RAISE EXCEPTION 'Invalid modification to posted journal; only void fields may change'
            USING ERRCODE = '55000';
        END IF;

        -- Any other update on posted journals is blocked
        RAISE EXCEPTION 'Cannot modify journal_entries in status posted'
          USING ERRCODE = '55000';
      END IF;

      -- If draft, allow normal updates (posting is draft->posted and is allowed)
      RETURN NEW;
    END IF;

    -- For INSERT just allow
    RETURN NEW;
  END IF;

  -- journal_entry_lines: block UPDATE/DELETE if parent journal posted/voided
  IF TG_TABLE_NAME = 'journal_entry_lines' THEN
    SELECT status INTO je_status FROM journal_entries
      WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);

    IF je_status IN ('posted','voided') THEN
      RAISE EXCEPTION 'Cannot modify journal_entry_lines for journal in status %', je_status
        USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure triggers exist (idempotent creation)
DO $$
BEGIN
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
