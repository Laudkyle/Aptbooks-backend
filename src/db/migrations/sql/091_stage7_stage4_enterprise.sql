-- Stage 7: Stage 4 Enterprise (Caching, Security, Retention, Integrations, Analytics scaffolding)

-- Permissions (idempotent)
INSERT INTO permissions (code, description)
VALUES
  ('reporting.analytics.read', 'Reporting: Analytics read'),
  ('reporting.analytics.manage', 'Reporting: Analytics manage'),
  ('core.dimension_security.read', 'Core: Dimension security read'),
  ('core.dimension_security.manage', 'Core: Dimension security manage'),
  ('integrations.connections.read', 'Integrations: Connections read'),
  ('integrations.connections.manage', 'Integrations: Connections manage')
ON CONFLICT (code) DO NOTHING;

-- Report cache for saved report runs (Stage 3)
CREATE TABLE IF NOT EXISTS report_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  cache_key TEXT NOT NULL,
  report_id UUID NULL,
  report_version_id UUID NULL,
  output_json JSONB NOT NULL,
  row_count INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS report_cache_org_key_uq ON report_cache(organization_id, cache_key);
CREATE INDEX IF NOT EXISTS report_cache_org_expires_idx ON report_cache(organization_id, expires_at);

-- Saved report version cache TTL
ALTER TABLE saved_report_versions
  ADD COLUMN IF NOT EXISTS cache_ttl_seconds INTEGER NULL;

-- Dimension-level access control rules (row-level security primitive)
CREATE TABLE IF NOT EXISTS dimension_access_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','role')),
  principal_id UUID NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  rule_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT NULL,
  created_by_user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dimension_access_rules_org_principal_idx
  ON dimension_access_rules(organization_id, principal_type, principal_id);

-- Data retention policies for operational/reporting artifacts
CREATE TABLE IF NOT EXISTS data_retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  entity_key TEXT NOT NULL,
  retention_days INTEGER NOT NULL CHECK (retention_days >= 0),
  note TEXT NULL,
  updated_by_user_id UUID NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS data_retention_policies_org_entity_uq
  ON data_retention_policies(organization_id, entity_key);

-- Integration connection registry (Stage 4 scaffolding)
CREATE TABLE IF NOT EXISTS integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','enabled','error')),
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_tested_at TIMESTAMPTZ NULL,
  last_test_result TEXT NULL,
  last_sync_at TIMESTAMPTZ NULL,
  created_by_user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_connections_org_idx ON integration_connections(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_org_type_name_uq
  ON integration_connections(organization_id, type, name);
