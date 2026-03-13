-- =============================================================================
-- document_workflow_statics
-- =============================================================================

CREATE TABLE IF NOT EXISTS document_workflow_statics (
  id                          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Scope
  organization_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_type_id            UUID        REFERENCES document_types(id) ON DELETE CASCADE,
  entity_type                 TEXT,

  -- Approval rules
  creator_can_approve         BOOLEAN     NOT NULL DEFAULT FALSE,
  creator_can_post            BOOLEAN     NOT NULL DEFAULT FALSE,
  allow_self_approval         BOOLEAN     NOT NULL DEFAULT FALSE,
  require_comment_on_rejection BOOLEAN    NOT NULL DEFAULT TRUE,
  notify_creator_on_approval  BOOLEAN     NOT NULL DEFAULT TRUE,
  notify_creator_on_rejection BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Audit
  created_by_user_id          UUID        REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id          UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One rule-set per (org, document_type, entity_type) combination
  UNIQUE (organization_id, document_type_id, entity_type)
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

-- Primary lookup: given a document, find its applicable rules
CREATE INDEX IF NOT EXISTS idx_dws_org_type
  ON document_workflow_statics (organization_id, document_type_id, entity_type);

-- Useful for listing all rules for an org (settings page)
CREATE INDEX IF NOT EXISTS idx_dws_org
  ON document_workflow_statics (organization_id);

-- ── updated_at trigger ────────────────────────────────────────────────────────
-- Reuses the set_updated_at() function already defined in the documents migration.

DROP TRIGGER IF EXISTS trg_dws_updated_at ON document_workflow_statics;
CREATE TRIGGER trg_dws_updated_at
  BEFORE UPDATE ON document_workflow_statics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();