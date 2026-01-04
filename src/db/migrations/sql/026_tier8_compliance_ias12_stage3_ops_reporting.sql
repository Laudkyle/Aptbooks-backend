-- IAS12 Stage 3: operational hardening, imports, reporting indexes
BEGIN;

-- Batch imports for temp differences (optional)
CREATE TABLE IF NOT EXISTS ias12_temp_difference_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual_import',
  filename text NULL,
  created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ias12_temp_differences
  ADD COLUMN IF NOT EXISTS import_batch_id uuid NULL REFERENCES ias12_temp_difference_import_batches(id) ON DELETE SET NULL;

-- Useful indexes for scale
CREATE INDEX IF NOT EXISTS idx_ias12_temp_differences_org_period
  ON ias12_temp_differences(organization_id, period_id);

CREATE INDEX IF NOT EXISTS idx_ias12_temp_differences_org_period_category
  ON ias12_temp_differences(organization_id, period_id, category_id);

CREATE INDEX IF NOT EXISTS idx_ias12_runs_org_period_status_created
  ON ias12_deferred_tax_runs(organization_id, period_id, run_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ias12_run_lines_run
  ON ias12_deferred_tax_run_lines(run_id);

CREATE INDEX IF NOT EXISTS idx_ias12_balances_org_period
  ON ias12_deferred_tax_balances(organization_id, period_id);

COMMIT;
