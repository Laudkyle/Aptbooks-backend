-- 040_tier8_compliance_ifrs9_advanced_engine.sql
-- IFRS 9 advanced engine: macroeconomic scenarios, behavioral analytics,
-- qualitative SICR triggers, and model-change approvals.

BEGIN;

ALTER TABLE IF EXISTS ifrs9_settings
  ADD COLUMN IF NOT EXISTS model_change_approval_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS ifrs9_ecl_models
  ADD COLUMN IF NOT EXISTS config_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS ifrs9_macro_scenarios (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  scenario_type TEXT NOT NULL DEFAULT 'BASE' CHECK (scenario_type IN ('BASE','UPSIDE','DOWNSIDE','CUSTOM')),
  probability_weight NUMERIC(9,6) NOT NULL DEFAULT 1 CHECK (probability_weight >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  variable_set JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from DATE,
  effective_to DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS ifrs9_macro_scenario_overlays (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scenario_id UUID NOT NULL REFERENCES ifrs9_macro_scenarios(id) ON DELETE CASCADE,
  model_id UUID REFERENCES ifrs9_ecl_models(id) ON DELETE CASCADE,
  segment TEXT,
  stage INT CHECK (stage IS NULL OR stage IN (1,2,3)),
  days_past_due_from INT,
  days_past_due_to INT,
  pd_multiplier NUMERIC(9,6) NOT NULL DEFAULT 1 CHECK (pd_multiplier >= 0),
  lgd_multiplier NUMERIC(9,6) NOT NULL DEFAULT 1 CHECK (lgd_multiplier >= 0),
  loss_rate_multiplier NUMERIC(9,6) NOT NULL DEFAULT 1 CHECK (loss_rate_multiplier >= 0),
  ecl_multiplier NUMERIC(9,6) NOT NULL DEFAULT 1 CHECK (ecl_multiplier >= 0),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (days_past_due_to IS NULL OR days_past_due_from IS NULL OR days_past_due_to >= days_past_due_from)
);
CREATE INDEX IF NOT EXISTS idx_ifrs9_scenario_overlays_scenario_model
  ON ifrs9_macro_scenario_overlays(scenario_id, model_id, stage);

CREATE TABLE IF NOT EXISTS ifrs9_sicr_qualitative_triggers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_partner_id UUID REFERENCES business_partners(id) ON DELETE CASCADE,
  segment TEXT,
  trigger_code TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  force_stage_min INT CHECK (force_stage_min IS NULL OR force_stage_min IN (1,2,3)),
  pd_multiplier NUMERIC(9,6) NOT NULL DEFAULT 1 CHECK (pd_multiplier >= 0),
  lgd_multiplier NUMERIC(9,6) NOT NULL DEFAULT 1 CHECK (lgd_multiplier >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  valid_from DATE,
  valid_to DATE,
  source TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ifrs9_sicr_trigger_org_bp ON ifrs9_sicr_qualitative_triggers(organization_id, business_partner_id, status);
CREATE INDEX IF NOT EXISTS idx_ifrs9_sicr_trigger_org_segment ON ifrs9_sicr_qualitative_triggers(organization_id, segment, status);

CREATE TABLE IF NOT EXISTS ifrs9_behavioral_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  as_of_date DATE NOT NULL,
  horizon_months INT NOT NULL DEFAULT 12 CHECK (horizon_months BETWEEN 1 AND 120),
  transition_window_days INT NOT NULL DEFAULT 30 CHECK (transition_window_days BETWEEN 1 AND 365),
  cure_rate NUMERIC(9,6),
  vintage_multiplier NUMERIC(9,6),
  transition_multiplier NUMERIC(9,6),
  lgd_multiplier NUMERIC(9,6),
  loss_rate_multiplier NUMERIC(9,6),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ifrs9_behavioral_snapshot_org_asof ON ifrs9_behavioral_snapshots(organization_id, as_of_date DESC);

CREATE TABLE IF NOT EXISTS ifrs9_model_change_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_id UUID REFERENCES ifrs9_ecl_models(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','applied')),
  workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rejection_comment TEXT,
  applied_at TIMESTAMPTZ,
  applied_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ifrs9_model_change_org_status ON ifrs9_model_change_requests(organization_id, status, created_at DESC);

ALTER TABLE IF EXISTS ifrs9_ecl_runs
  ADD COLUMN IF NOT EXISTS scenario_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS behavioral_snapshot JSONB;

ALTER TABLE IF EXISTS ifrs9_ecl_run_lines
  ADD COLUMN IF NOT EXISTS scenario_effects JSONB,
  ADD COLUMN IF NOT EXISTS behavioral_effects JSONB;

COMMIT;
