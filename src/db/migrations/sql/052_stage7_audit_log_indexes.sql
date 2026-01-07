-- Stage 7: Audit trail hardening

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_action_created
  ON audit_logs(organization_id, action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_actor_created
  ON audit_logs(organization_id, actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_entity_created
  ON audit_logs(organization_id, entity_type, entity_id, created_at DESC);

-- Definition audit table already exists from Stage 5; add a supporting index for UI filtering.
CREATE INDEX IF NOT EXISTS idx_reporting_def_audit_org_entity_changed
  ON reporting_definition_audit(organization_id, entity_type, changed_at DESC);
