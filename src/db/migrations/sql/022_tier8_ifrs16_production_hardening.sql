-- Tier 8 (Part A): IFRS 16 Leases - production hardening
-- Adds lifecycle metadata, payment timing, and expands status domain.

BEGIN;

-- Expand status domain (drop old check and recreate)
ALTER TABLE leases
  DROP CONSTRAINT IF EXISTS leases_status_check;

ALTER TABLE leases
  ADD CONSTRAINT leases_status_check
  CHECK (status IN ('draft','active','terminated','closed'));

-- Payment timing (arrears vs advance)
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS payment_timing text NOT NULL DEFAULT 'arrears';

ALTER TABLE leases
  DROP CONSTRAINT IF EXISTS leases_payment_timing_check;

ALTER TABLE leases
  ADD CONSTRAINT leases_payment_timing_check
  CHECK (payment_timing IN ('arrears','advance'));

-- Lifecycle metadata
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS activated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS terminated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS status_reason text NULL;

CREATE INDEX IF NOT EXISTS idx_leases_org_status
  ON leases(organization_id, status);

COMMIT;
