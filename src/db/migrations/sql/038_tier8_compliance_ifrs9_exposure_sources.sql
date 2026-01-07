-- 038_tier8_compliance_ifrs9_exposure_sources.sql
-- IFRS 9 (Tier 8) - Stage 1/2: Extend run lines to track non-invoice exposure sources
-- (e.g., IFRS 15 contract assets) while keeping backward compatibility with invoice-based counts.

BEGIN;

ALTER TABLE IF EXISTS ifrs9_ecl_run_lines
  ADD COLUMN IF NOT EXISTS contract_asset_count INT NOT NULL DEFAULT 0;

-- Stage 2 (GENERAL) run lines do not always have a bucket-driven ageing/loss-rate.
-- Relax NOT NULL constraints to support general ECL lines.
ALTER TABLE ifrs9_ecl_run_lines ALTER COLUMN bucket_id DROP NOT NULL;
ALTER TABLE ifrs9_ecl_run_lines ALTER COLUMN loss_rate DROP NOT NULL;

COMMIT;
