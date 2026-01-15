-- Stage 2 (Phase 4): Journal lifecycle workflow + safe archiving

BEGIN;

-- Journal workflow metadata
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(id);
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id);
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS canceled_by UUID REFERENCES users(id);

-- Expand journal status enum
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_status_check;
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_status_check
  CHECK (status IN ('draft','submitted','approved','rejected','posted','voided','canceled'));

-- COA archive metadata (soft delete semantics). Status remains 'active'|'inactive'
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(id);

COMMIT;
