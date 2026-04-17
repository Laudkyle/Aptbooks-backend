-- 039_tier8_compliance_ifrs9_audit_hardening.sql
-- Harden IFRS 9 runs for audit support without breaking existing data.

BEGIN;

ALTER TABLE IF EXISTS ifrs9_ecl_runs
  ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'passed'
    CHECK (validation_status IN ('passed','warning','failed'));

ALTER TABLE IF EXISTS ifrs9_ecl_runs
  ADD COLUMN IF NOT EXISTS settings_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS model_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS coverage_summary JSONB,
  ADD COLUMN IF NOT EXISTS run_hash TEXT;

ALTER TABLE IF EXISTS ifrs9_ecl_run_lines
  ADD COLUMN IF NOT EXISTS stage_reason TEXT,
  ADD COLUMN IF NOT EXISTS source_mix JSONB;

CREATE INDEX IF NOT EXISTS idx_ifrs9_runs_org_period_status
  ON ifrs9_ecl_runs(organization_id, period_id, status);

CREATE INDEX IF NOT EXISTS idx_ifrs9_runs_run_hash
  ON ifrs9_ecl_runs(run_hash);

COMMIT;
