-- Stage 7: Reporting reproducibility metadata
-- Adds deterministic metadata to make generated statements reproducible and auditable.

ALTER TABLE financial_statements
  ADD COLUMN IF NOT EXISTS parameters_hash TEXT,
  ADD COLUMN IF NOT EXISTS template_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_snapshot_at TIMESTAMPTZ;

-- Helpful indexes for audit/external tooling.
CREATE INDEX IF NOT EXISTS idx_financial_statements_org_generated_at
  ON financial_statements(organization_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_financial_statements_org_statement_period
  ON financial_statements(organization_id, statement_type, period_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_financial_statements_org_parameters_hash
  ON financial_statements(organization_id, parameters_hash);
