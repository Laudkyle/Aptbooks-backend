-- 013_tier4_phase3_upgrade.sql
-- Phase 3 (Option A): proration-ready + multi-schedule per asset + disposal posting traceability
-- Idempotent & safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================================
-- 1) Enable multi-schedule per asset (components/revaluations)
-- =========================================================

-- 1.1 Drop the "one schedule per asset" constraint (created by UNIQUE(asset_id))
-- Default PG name from "UNIQUE (asset_id)" is typically: asset_depreciation_schedules_asset_id_key
ALTER TABLE IF EXISTS asset_depreciation_schedules
  DROP CONSTRAINT IF EXISTS asset_depreciation_schedules_asset_id_key;

-- 1.2 Add schedule segmentation fields (Option A minimal)
ALTER TABLE IF EXISTS asset_depreciation_schedules
  ADD COLUMN IF NOT EXISTS effective_start_date DATE,
  ADD COLUMN IF NOT EXISTS effective_end_date DATE,
  ADD COLUMN IF NOT EXISTS component_code TEXT;

-- Backfill effective_start_date if NULL (safe)
UPDATE asset_depreciation_schedules
SET effective_start_date = depreciation_start_date
WHERE effective_start_date IS NULL;

-- Enforce NOT NULL after backfill (safe)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name='asset_depreciation_schedules'
      AND column_name='effective_start_date'
      AND is_nullable='YES'
  ) THEN
    ALTER TABLE asset_depreciation_schedules
      ALTER COLUMN effective_start_date SET NOT NULL;
  END IF;
END $$;

-- Helpful index for eligibility queries by period boundaries
CREATE INDEX IF NOT EXISTS idx_depr_sched_org_effective
  ON asset_depreciation_schedules(organization_id, status, effective_start_date, effective_end_date);

-- =========================================================
-- 2) Fix depreciation transaction uniqueness for multi-schedule
-- =========================================================

-- Your v1 unique index prevents multiple schedules for the same asset in one period:
--   uq_asset_depr_tx_once ON (organization_id, asset_id, period_id)
-- Drop it and replace with schedule-scoped uniqueness:
--   UNIQUE (organization_id, schedule_id, period_id)

DROP INDEX IF EXISTS uq_asset_depr_tx_once;

CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_depr_tx_once_per_schedule
  ON asset_depreciation_transactions(organization_id, schedule_id, period_id);

-- Keep/ensure a fast lookup index by asset+period for reporting
CREATE INDEX IF NOT EXISTS idx_depr_tx_asset_period
  ON asset_depreciation_transactions(organization_id, asset_id, period_id);

-- =========================================================
-- 3) Disposal posting traceability + category gain/loss accounts
-- =========================================================

-- 3.1 Add disposal fields to fixed_assets
-- Note: you already have disposed_at TIMESTAMPTZ; for proration and consistency we add disposed_date DATE.
ALTER TABLE IF EXISTS fixed_assets
  ADD COLUMN IF NOT EXISTS disposed_date DATE,
  ADD COLUMN IF NOT EXISTS disposal_proceeds NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (disposal_proceeds >= 0),
  ADD COLUMN IF NOT EXISTS disposal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS disposed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS disposal_memo TEXT;

-- Optional backfill: if you already set disposed_at, derive disposed_date for existing rows
UPDATE fixed_assets
SET disposed_date = (disposed_at AT TIME ZONE 'UTC')::date
WHERE disposed_date IS NULL AND disposed_at IS NOT NULL;

-- Index for disposal gating queries
CREATE INDEX IF NOT EXISTS idx_fixed_assets_org_disposed_date
  ON fixed_assets(organization_id, disposed_date);

-- 3.2 Add gain/loss accounts at category level (Option A minimal; defaults can be required by service)
ALTER TABLE IF EXISTS asset_categories
  ADD COLUMN IF NOT EXISTS disposal_gain_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS disposal_loss_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT;

-- Index for category posting lookups
CREATE INDEX IF NOT EXISTS idx_asset_categories_org_accounts
  ON asset_categories(organization_id, asset_account_id, accum_depr_account_id, depr_expense_account_id);

-- =========================================================
-- 4) Run-level safety (optional but recommended): keep existing but ensure it exists
-- =========================================================

-- Your existing table already has UNIQUE(organization_id, period_id).
-- Ensure a supporting index exists (safe).
CREATE INDEX IF NOT EXISTS idx_depr_runs_org_period
  ON asset_depreciation_runs(organization_id, period_id);

-- End of migration
