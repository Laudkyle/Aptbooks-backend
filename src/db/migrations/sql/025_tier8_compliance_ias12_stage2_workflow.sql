-- Tier 8 / IAS 12 Stage 2
-- Workflow hardening: draft -> final -> posted, plus reversals.

-- Runs: add workflow + traceability
ALTER TABLE ias12_deferred_tax_runs
  ADD COLUMN IF NOT EXISTS run_status VARCHAR(16) NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS run_type VARCHAR(16) NOT NULL DEFAULT 'original',
  ADD COLUMN IF NOT EXISTS input_hash VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS memo TEXT NULL,
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS finalized_by UUID NULL,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS posted_by UUID NULL,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS reversed_by UUID NULL,
  ADD COLUMN IF NOT EXISTS reverse_reason TEXT NULL;

-- Backward compatibility: if Stage 1 wrote into "status", keep it but prefer run_status.
-- Ensure the old status column exists before updating.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='ias12_deferred_tax_runs' AND column_name='status'
  ) THEN
    UPDATE ias12_deferred_tax_runs
      SET run_status = COALESCE(run_status, status)
      WHERE run_status IS NULL;
  END IF;
END$$;

-- Posting record: support reversals and re-posting after reversal
ALTER TABLE ias12_deferred_tax_postings
  ADD COLUMN IF NOT EXISTS prior_journal_id UUID NULL,
  ADD COLUMN IF NOT EXISTS reversal_journal_id UUID NULL,
  ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS reversed_by UUID NULL,
  ADD COLUMN IF NOT EXISTS reverse_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_ias12_runs_org_period_status
  ON ias12_deferred_tax_runs(organization_id, period_id, run_status, created_at DESC);
