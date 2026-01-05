-- Tier 8 / IAS 12 Production Hardening
-- 1) Make schema robust to retries and varying rounding precision
-- 2) Preserve auditability by preventing in-place mutation of temp differences once used in FINAL/POSTED runs

BEGIN;

-- UUID generators (deployment-safe)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Use higher precision for computed amounts so rounding_decimals can be > 2 without data loss
ALTER TABLE ias12_deferred_tax_run_lines
  ALTER COLUMN computed_tax_amount TYPE NUMERIC(18,6);

ALTER TABLE ias12_deferred_tax_balances
  ALTER COLUMN opening_dta TYPE NUMERIC(18,6),
  ALTER COLUMN opening_dtl TYPE NUMERIC(18,6),
  ALTER COLUMN closing_dta TYPE NUMERIC(18,6),
  ALTER COLUMN closing_dtl TYPE NUMERIC(18,6),
  ALTER COLUMN movement_dta TYPE NUMERIC(18,6),
  ALTER COLUMN movement_dtl TYPE NUMERIC(18,6),
  ALTER COLUMN deferred_tax_expense TYPE NUMERIC(18,6);

-- Temp differences: introduce soft-deactivation + supersession metadata
ALTER TABLE ias12_temp_differences
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS superseded_by UUID NULL,
  ADD COLUMN IF NOT EXISTS superseded_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_ias12_td_org_period_active
  ON ias12_temp_differences(organization_id, period_id, is_active);

COMMIT;
