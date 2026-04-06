-- Global approval ladder for documents by organization.
-- Used as fallback when a document type has no explicit approval ladder.

CREATE TABLE IF NOT EXISTS document_global_approval_levels (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  approval_level_id UUID NOT NULL REFERENCES approval_levels(id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, approval_level_id),
  UNIQUE (organization_id, position)
);

CREATE INDEX IF NOT EXISTS idx_document_global_approval_levels_org_pos
  ON document_global_approval_levels (organization_id, position);
