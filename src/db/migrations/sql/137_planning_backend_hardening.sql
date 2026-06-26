-- Planning backend hardening: compatibility and lifecycle fixes

-- Allocation bases/rules use soft archive in the service layer. Older installs only allowed
-- active/inactive, so make the database constraint match the application lifecycle.
ALTER TABLE allocation_bases DROP CONSTRAINT IF EXISTS allocation_bases_status_check;
ALTER TABLE allocation_bases
  ADD CONSTRAINT allocation_bases_status_check
  CHECK (status IN ('active', 'inactive', 'archived'));

ALTER TABLE allocation_rules DROP CONSTRAINT IF EXISTS allocation_rules_status_check;
ALTER TABLE allocation_rules
  ADD CONSTRAINT allocation_rules_status_check
  CHECK (status IN ('active', 'inactive', 'archived'));

CREATE INDEX IF NOT EXISTS idx_allocation_bases_org_status
  ON allocation_bases(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_allocation_rules_org_status
  ON allocation_rules(organization_id, status);

-- Forecast version archive workflow is now exposed directly to the frontend.
ALTER TABLE forecast_versions DROP CONSTRAINT IF EXISTS forecast_versions_workflow_status_check;
ALTER TABLE forecast_versions
  ADD CONSTRAINT forecast_versions_workflow_status_check
  CHECK (workflow_status IN ('draft','in_review','approved','rejected','archived'));

CREATE INDEX IF NOT EXISTS idx_forecast_versions_org_forecast_status
  ON forecast_versions(organization_id, forecast_id, status);

-- Budget version editing endpoint expects these metadata columns where stage-2
-- workflow migrations may not have been applied cleanly on older databases.
ALTER TABLE budget_versions
  ADD COLUMN IF NOT EXISTS scenario_key TEXT,
  ADD COLUMN IF NOT EXISTS template_source_version_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_budget_versions_org_budget_status
  ON budget_versions(organization_id, budget_id, status);
