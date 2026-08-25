BEGIN;

-- Global Analytics & Dashboard Studio. Evolves the Stage 7 dashboard scaffold
-- without replacing dashboard identifiers or deleting legacy definitions.

ALTER TABLE dashboards
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS default_filters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_saved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE dashboards
   SET owner_user_id=COALESCE(owner_user_id, created_by_user_id)
 WHERE owner_user_id IS NULL;

ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_visibility_chk;
ALTER TABLE dashboards ADD CONSTRAINT dashboards_visibility_chk
  CHECK (visibility IN ('private','shared','organization','system'));
ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_status_chk;
ALTER TABLE dashboards ADD CONSTRAINT dashboards_status_chk
  CHECK (status IN ('active','archived'));
ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_version_chk;
ALTER TABLE dashboards ADD CONSTRAINT dashboards_version_chk CHECK (version > 0);

ALTER TABLE dashboard_widgets
  ADD COLUMN IF NOT EXISTS metric_key TEXT,
  ADD COLUMN IF NOT EXISTS visualization TEXT,
  ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

UPDATE dashboard_widgets
   SET visualization=COALESCE(visualization, NULLIF(widget_type,''))
 WHERE visualization IS NULL;

CREATE TABLE IF NOT EXISTS dashboard_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','role')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (principal_type='user' AND user_id IS NOT NULL AND role_id IS NULL)
    OR (principal_type='role' AND role_id IS NOT NULL AND user_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_share_user
  ON dashboard_shares(dashboard_id,user_id) WHERE principal_type='user';
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_share_role
  ON dashboard_shares(dashboard_id,role_id) WHERE principal_type='role';

CREATE TABLE IF NOT EXISTS dashboard_placements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  location_key TEXT NOT NULL,
  placement_scope TEXT NOT NULL CHECK (placement_scope IN ('user','role','organization')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (placement_scope='user' AND user_id IS NOT NULL AND role_id IS NULL)
    OR (placement_scope='role' AND role_id IS NOT NULL AND user_id IS NULL)
    OR (placement_scope='organization' AND user_id IS NULL AND role_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_dashboard_placements_lookup
  ON dashboard_placements(organization_id,location_key,placement_scope,sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_placement_user
  ON dashboard_placements(dashboard_id,location_key,user_id) WHERE placement_scope='user';
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_placement_role
  ON dashboard_placements(dashboard_id,location_key,role_id) WHERE placement_scope='role';
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_placement_org
  ON dashboard_placements(dashboard_id,location_key) WHERE placement_scope='organization';

CREATE TABLE IF NOT EXISTS dashboard_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition_json JSONB NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(dashboard_id,version)
);

CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  dashboard_version INTEGER NOT NULL,
  name TEXT,
  definition_json JSONB NOT NULL,
  data_json JSONB NOT NULL,
  generated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dashboard_snapshots_dashboard
  ON dashboard_snapshots(organization_id,dashboard_id,generated_at DESC);

-- Reusable user/organization templates are independent from live dashboards.
CREATE TABLE IF NOT EXISTS dashboard_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  template_scope TEXT NOT NULL DEFAULT 'private' CHECK (template_scope IN ('private','organization')),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  definition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  last_saved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dashboard_templates_org_scope
  ON dashboard_templates(organization_id,template_scope,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_template_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES dashboard_templates(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition_json JSONB NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(template_id,version)
);

-- New Dashboard Studio tables are tenant-owned and fail closed under RLS.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'dashboard_shares','dashboard_placements','dashboard_revisions','dashboard_snapshots',
    'dashboard_templates','dashboard_template_revisions'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS aptbooks_tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY aptbooks_tenant_isolation ON public.%I USING (organization_id=aptbooks_current_organization_id()) WITH CHECK (organization_id=aptbooks_current_organization_id())',
      t
    );
  END LOOP;
END $$;

-- Existing tables predate migration 161 in some installations; enforce RLS here as well.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dashboards','dashboard_widgets'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS aptbooks_tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY aptbooks_tenant_isolation ON public.%I USING (organization_id=aptbooks_current_organization_id()) WITH CHECK (organization_id=aptbooks_current_organization_id())',
      t
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_dashboards_owner_updated
  ON dashboards(organization_id,owner_user_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_metric
  ON dashboard_widgets(organization_id,dashboard_id,metric_key)
  WHERE is_archived=FALSE;

COMMIT;
