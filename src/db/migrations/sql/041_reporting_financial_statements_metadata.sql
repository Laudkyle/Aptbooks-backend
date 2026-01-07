-- Reporting Stage 1: Financial statement persistence metadata
--
-- Adds comparative / YTD metadata and aligns persistence fields for reproducible reporting.

BEGIN;

ALTER TABLE financial_statements
  ADD COLUMN IF NOT EXISTS compare_period_id UUID NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'period' CHECK (mode IN ('period','ytd','as_of')),
  ADD COLUMN IF NOT EXISTS parameters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS generated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;

-- Backfill generated_at/from created_at for existing rows where generated_at is null
UPDATE financial_statements
SET generated_at = COALESCE(generated_at, created_at)
WHERE generated_at IS NULL;

-- Keep existing column (generated_by_user_id) if present in schema; also backfill generated_by.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='financial_statements' AND column_name='generated_by_user_id'
  ) THEN
    UPDATE financial_statements
    SET generated_by = COALESCE(generated_by, generated_by_user_id)
    WHERE generated_by IS NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_financial_statements_org_period_generated
  ON financial_statements(organization_id, period_id, statement_type, generated_at DESC);

COMMIT;
