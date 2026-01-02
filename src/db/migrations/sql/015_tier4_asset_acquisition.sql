-- 015_tier4_asset_acquisition.sql
-- Phase 3 operational completeness: explicit acquisition action (separate from asset master creation)
-- Adds traceability fields for acquisition posting.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

ALTER TABLE IF EXISTS fixed_assets
  ADD COLUMN IF NOT EXISTS acquired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acquired_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS acquisition_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS acquisition_memo TEXT;

-- Helpful index for acquisition traceability queries
CREATE INDEX IF NOT EXISTS idx_fixed_assets_org_acquired_at
  ON fixed_assets(organization_id, acquired_at);
