-- Stage 7 (Reporting & Planning) - Stage 3: Report Builder, Dashboards, Collaboration & Scheduling

-- Permissions
INSERT INTO permissions(code, description) VALUES
  ('reporting.reports.read', 'Read saved reports and run reports'),
  ('reporting.reports.manage', 'Create/update/share/schedule saved reports'),
  ('reporting.dashboards.read', 'Read dashboards'),
  ('reporting.dashboards.manage', 'Create/update dashboards and widgets'),
  ('reporting.management.read', 'Read management reports'),
  ('reporting.management.manage', 'Manage management report templates/config')
ON CONFLICT (code) DO NOTHING;

-- Saved report definitions
CREATE TABLE IF NOT EXISTS saved_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  folder TEXT,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_reports_org_archived ON saved_reports(organization_id, is_archived);

-- Versioned content (SQL or template spec)
CREATE TABLE IF NOT EXISTS saved_report_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  saved_report_id UUID NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sql' CHECK (kind IN ('sql','management')),
  query_sql TEXT,
  template_key TEXT,
  parameters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_report_versions_num
  ON saved_report_versions(saved_report_id, version_number);

CREATE INDEX IF NOT EXISTS idx_saved_report_versions_org
  ON saved_report_versions(organization_id, saved_report_id);

-- Sharing (by user or role)
CREATE TABLE IF NOT EXISTS saved_report_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  saved_report_id UUID NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  share_type TEXT NOT NULL CHECK (share_type IN ('user','role')),
  user_id UUID,
  role_id UUID,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_report_shares_org_report ON saved_report_shares(organization_id, saved_report_id);

-- Schedules (DB persisted; runner executes)
CREATE TABLE IF NOT EXISTS saved_report_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  saved_report_id UUID NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  version_id UUID REFERENCES saved_report_versions(id) ON DELETE SET NULL,
  name TEXT,
  schedule_type TEXT NOT NULL DEFAULT 'interval_seconds' CHECK (schedule_type IN ('interval_seconds','daily_at_utc')),
  interval_seconds INTEGER,
  daily_hour_utc INTEGER,
  daily_minute_utc INTEGER,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_report_schedules_due
  ON saved_report_schedules(is_enabled, next_run_at);

CREATE INDEX IF NOT EXISTS idx_saved_report_schedules_org
  ON saved_report_schedules(organization_id, saved_report_id);

-- Run history
CREATE TABLE IF NOT EXISTS saved_report_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  saved_report_id UUID NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  version_id UUID REFERENCES saved_report_versions(id) ON DELETE SET NULL,
  schedule_id UUID REFERENCES saved_report_schedules(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error TEXT,
  row_count INTEGER,
  output_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_saved_report_runs_org_report
  ON saved_report_runs(organization_id, saved_report_id, started_at DESC);

-- Comments
CREATE TABLE IF NOT EXISTS saved_report_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  saved_report_id UUID NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  user_id UUID,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_report_comments_org_report
  ON saved_report_comments(organization_id, saved_report_id, created_at DESC);

-- Document links (attachments)
CREATE TABLE IF NOT EXISTS saved_report_document_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  saved_report_id UUID NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  document_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_report_docs_org_report
  ON saved_report_document_links(organization_id, saved_report_id);

-- Dashboards
CREATE TABLE IF NOT EXISTS dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  layout_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dashboards_org_archived
  ON dashboards(organization_id, is_archived);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  widget_type TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  position_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_dash
  ON dashboard_widgets(dashboard_id, is_archived);
