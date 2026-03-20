
BEGIN;

CREATE TABLE IF NOT EXISTS document_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  category TEXT NOT NULL DEFAULT 'transaction_document',
  base_template_key TEXT NOT NULL,
  paper_size TEXT NOT NULL DEFAULT 'A4',
  orientation TEXT NOT NULL DEFAULT 'portrait',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_document_templates_org_active
  ON document_templates(organization_id, is_active, category);

CREATE TABLE IF NOT EXISTS document_template_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  layout_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  branding_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'published',
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_document_template_versions_template
  ON document_template_versions(template_id, version_no DESC);

CREATE TABLE IF NOT EXISTS document_template_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  template_id UUID NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  template_version_id UUID NULL REFERENCES document_template_versions(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NULL,
  created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_document_template_assignments_org_entity
  ON document_template_assignments(organization_id, entity_type, is_active);

CREATE TABLE IF NOT EXISTS document_render_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NULL,
  template_id UUID NULL REFERENCES document_templates(id) ON DELETE SET NULL,
  template_version_id UUID NULL REFERENCES document_template_versions(id) ON DELETE SET NULL,
  render_mode TEXT NOT NULL DEFAULT 'preview',
  rendered_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  rendered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_render_logs_org_rendered_at
  ON document_render_logs(organization_id, rendered_at DESC);

COMMIT;
