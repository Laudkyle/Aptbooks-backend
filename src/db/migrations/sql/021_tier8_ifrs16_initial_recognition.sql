-- Tier 8 (Part A): IFRS 16 - Initial recognition posting support

BEGIN;

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS initial_recognition_journal_id uuid NULL REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS initial_recognition_date date NULL;

CREATE INDEX IF NOT EXISTS idx_leases_initial_recognition
  ON leases(organization_id, initial_recognition_date);

COMMIT;
