-- Tier 6: KPI enhancements (typed KPIs + soft delete + nullable values)

ALTER TABLE kpi_definitions
  ADD COLUMN IF NOT EXISTS kpi_type TEXT,
  ADD COLUMN IF NOT EXISTS account_id UUID,
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

-- Keep existing status column, but expand to include archived
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='kpi_definitions_status_check'
  ) THEN
    ALTER TABLE kpi_definitions DROP CONSTRAINT kpi_definitions_status_check;
  END IF;
END $$;

ALTER TABLE kpi_definitions
  ADD CONSTRAINT kpi_definitions_status_check CHECK (status IN ('active','inactive','archived'));

ALTER TABLE kpi_definitions
  ADD CONSTRAINT kpi_definitions_kpi_type_check CHECK (kpi_type IS NULL OR kpi_type IN ('ACCOUNT_BALANCE','EXPRESSION'));

ALTER TABLE kpi_definitions
  ADD CONSTRAINT kpi_definitions_account_fk FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;

-- Allow null KPI values (for cases where upstream data is missing)
ALTER TABLE kpi_values
  ALTER COLUMN value DROP NOT NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_kpi_definitions_org_status ON kpi_definitions(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_kpi_values_org_period ON kpi_values(organization_id, period_id);
