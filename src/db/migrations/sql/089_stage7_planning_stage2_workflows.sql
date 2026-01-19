-- Stage 7 (Reporting & Planning) - Stage 2 Planning Workflows

-- Budgets: workflow fields, scenarios, templates, and alert rules
ALTER TABLE budget_versions
  ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS scenario_key TEXT,
  ADD COLUMN IF NOT EXISTS template_source_version_id UUID;

ALTER TABLE budget_versions DROP CONSTRAINT IF EXISTS budget_versions_workflow_status_check;
ALTER TABLE budget_versions
  ADD CONSTRAINT budget_versions_workflow_status_check
  CHECK (workflow_status IN ('draft','in_review','approved','rejected','archived'));

CREATE TABLE IF NOT EXISTS budget_alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  budget_id UUID NOT NULL,
  name TEXT NOT NULL,
  threshold_pct NUMERIC(12,4) NOT NULL,
  -- optional scoping
  account_id UUID,
  dimension_json JSONB NOT NULL DEFAULT '{}',
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_alert_rules_org_budget ON budget_alert_rules(organization_id, budget_id);

-- Forecasts: workflow fields, scenarios, probability weighting, templates
ALTER TABLE forecast_versions
  ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS scenario_key TEXT,
  ADD COLUMN IF NOT EXISTS probability_weight NUMERIC(7,4),
  ADD COLUMN IF NOT EXISTS template_source_version_id UUID;

ALTER TABLE forecast_versions DROP CONSTRAINT IF EXISTS forecast_versions_workflow_status_check;
ALTER TABLE forecast_versions
  ADD CONSTRAINT forecast_versions_workflow_status_check
  CHECK (workflow_status IN ('draft','in_review','approved','rejected','archived'));

-- KPIs: metadata + targets/thresholds
ALTER TABLE kpi_definitions
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS owner_user_id UUID,
  ADD COLUMN IF NOT EXISTS documentation TEXT;

CREATE TABLE IF NOT EXISTS kpi_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  kpi_definition_id UUID NOT NULL REFERENCES kpi_definitions(id) ON DELETE CASCADE,
  -- optional period scope: if null, applies globally
  period_id UUID,
  direction TEXT NOT NULL DEFAULT 'higher' CHECK (direction IN ('higher','lower')),
  target_value NUMERIC(18,4) NOT NULL,
  amber_threshold NUMERIC(18,4),
  red_threshold NUMERIC(18,4),
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kpi_targets_org_kpi ON kpi_targets(organization_id, kpi_definition_id);
CREATE INDEX IF NOT EXISTS idx_kpi_targets_org_kpi_period ON kpi_targets(organization_id, kpi_definition_id, period_id);
