CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS asset_depreciation_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','posted','failed','skipped')),

  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error TEXT,

  UNIQUE (organization_id, period_id)
);

CREATE TABLE IF NOT EXISTS asset_depreciation_run_postings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  depreciation_run_id UUID NOT NULL REFERENCES asset_depreciation_runs(id) ON DELETE CASCADE,
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (depreciation_run_id)
);

CREATE INDEX IF NOT EXISTS idx_depr_runs_org_period
  ON asset_depreciation_runs(organization_id, period_id);
