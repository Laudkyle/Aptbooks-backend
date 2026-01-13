-- Tier 6: KPI values idempotency

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'kpi_values_org_def_period_asof_uniq'
  ) THEN
    ALTER TABLE kpi_values
      ADD CONSTRAINT kpi_values_org_def_period_asof_uniq
      UNIQUE (organization_id, kpi_definition_id, period_id, as_of_date);
  END IF;
END $$;
