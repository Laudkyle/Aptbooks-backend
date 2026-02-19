-- Tier 10: Documents & Workflow (local filesystem storage driver)

-- -----------------------------------------------------------------------------
-- Permissions (seed)
-- -----------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('documents.read', 'Read documents and document metadata'),
  ('documents.create', 'Create documents and upload new versions'),
  ('documents.manage', 'Manage documents (edit metadata, delete, configure types)'),
  ('approvals.act', 'Approve or reject documents in workflow')
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Document Types
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

-- -----------------------------------------------------------------------------
-- Workflow States (minimal state machine; extend later if needed)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_states (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO workflow_states (code, name, is_terminal) VALUES
  ('DRAFT', 'Draft', FALSE),
  ('SUBMITTED', 'Submitted', FALSE),
  ('APPROVED', 'Approved', TRUE),
  ('REJECTED', 'Rejected', TRUE)
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Approval Levels + Document Type Approval Map (multi-level approvals)
--
-- approval_levels define an org's approval ladder.
-- document_type_approval_levels binds a document_type to that ladder.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_levels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sequence INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, sequence)
);

CREATE TABLE IF NOT EXISTS document_type_approval_levels (
  document_type_id UUID NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
  approval_level_id UUID NOT NULL REFERENCES approval_levels(id) ON DELETE CASCADE,
  PRIMARY KEY (document_type_id, approval_level_id)
);

-- -----------------------------------------------------------------------------
-- Documents
--
-- IMPORTANT: entity_type/entity_id are polymorphic references to higher-tier
-- entities (no foreign keys) to keep the module pluggable.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_type_id UUID REFERENCES document_types(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  entity_ref TEXT,
  workflow_state_code TEXT NOT NULL DEFAULT 'DRAFT' REFERENCES workflow_states(code),
  current_version_no INT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_org_entity ON documents(organization_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_documents_org_state ON documents(organization_id, workflow_state_code);

-- -----------------------------------------------------------------------------
-- Document Versions
--
-- storage_relpath is a path relative to FILE_STORAGE_ROOT.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no INT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  storage_relpath TEXT NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_document_versions_document_created ON document_versions(document_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Document Approvals
--
-- One row per approval level per document, created at SUBMIT time.
-- Status flow: QUEUED -> PENDING -> APPROVED/REJECTED
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_approvals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  approval_level_id UUID NOT NULL REFERENCES approval_levels(id) ON DELETE RESTRICT,
  sequence INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  acted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  acted_at TIMESTAMPTZ,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, approval_level_id),
  UNIQUE (document_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_document_approvals_document_seq ON document_approvals(document_id, sequence);
CREATE INDEX IF NOT EXISTS idx_document_approvals_pending ON document_approvals(status);

-- -----------------------------------------------------------------------------
-- Update trigger: documents.updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_documents_updated_at ON documents;
CREATE TRIGGER trg_documents_updated_at
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
