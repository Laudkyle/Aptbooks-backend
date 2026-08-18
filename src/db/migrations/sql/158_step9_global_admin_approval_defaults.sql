BEGIN;

-- Step 9: make approvals operational by default.
-- Every organization receives a global fallback approval ladder whose default
-- approver is the organization Admin role. Document-type ladders remain explicit
-- overrides and continue to take precedence over this global ladder.

-- Ensure Admin roles can act on approvals (covers older tenants provisioned
-- before approvals.act existed).
INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'approvals.act'
WHERE LOWER(r.name) IN ('admin','administrator','super admin','owner')
ON CONFLICT DO NOTHING;

-- Ensure every organization has the canonical default level. Organizations
-- created after migration 054 normally already have this level from the trigger.
INSERT INTO approval_levels(organization_id, code, name, sequence, is_active)
SELECT
  o.id,
  'DEFAULT_APPROVE',
  'Default Approver',
  COALESCE((SELECT MIN(al.sequence) - 1 FROM approval_levels al WHERE al.organization_id=o.id), 1),
  TRUE
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM approval_levels al
  WHERE al.organization_id=o.id AND al.code='DEFAULT_APPROVE'
);

UPDATE approval_levels
SET is_active=TRUE, name='Default Approver'
WHERE code='DEFAULT_APPROVE';

-- Use the default level as the global fallback only when the organization has
-- not already configured a global ladder. Existing admin-configured global
-- ladders are preserved.
INSERT INTO document_global_approval_levels(organization_id, approval_level_id, position)
SELECT o.id, al.id, 0
FROM organizations o
JOIN approval_levels al
  ON al.organization_id=o.id
 AND al.code='DEFAULT_APPROVE'
WHERE NOT EXISTS (
  SELECT 1 FROM document_global_approval_levels g
  WHERE g.organization_id=o.id
)
ON CONFLICT DO NOTHING;

-- The default global level is owned by the Admin role. Assign every active,
-- non-system admin so adding another administrator does not orphan approvals.
INSERT INTO approval_level_users(approval_level_id, user_id)
SELECT DISTINCT al.id, u.id
FROM approval_levels al
JOIN users u ON u.organization_id=al.organization_id
JOIN user_roles ur ON ur.user_id=u.id
JOIN roles r ON r.id=ur.role_id AND r.organization_id=al.organization_id
WHERE al.code='DEFAULT_APPROVE'
  AND u.status='active'
  AND u.is_system=FALSE
  AND LOWER(r.name) IN ('admin','administrator','super admin','owner')
ON CONFLICT DO NOTHING;

-- Repair already-submitted workflow documents that were submitted before a
-- ladder existed. Resolve a document-specific ladder first; otherwise use the
-- global fallback. Position, not approval-level sequence, defines workflow order.
WITH submitted_without_steps AS (
  SELECT d.id AS document_id, d.organization_id, d.document_type_id
  FROM documents d
  WHERE d.workflow_state_code='SUBMITTED'
    AND NOT EXISTS (
      SELECT 1 FROM document_approvals da WHERE da.document_id=d.id
    )
), explicit_ladder AS (
  SELECT
    s.document_id,
    dtal.approval_level_id,
    dtal.position,
    TRUE AS is_explicit
  FROM submitted_without_steps s
  JOIN document_type_approval_levels dtal ON dtal.document_type_id=s.document_type_id
  JOIN approval_levels al ON al.id=dtal.approval_level_id
   AND al.organization_id=s.organization_id
   AND al.is_active=TRUE
), global_ladder AS (
  SELECT
    s.document_id,
    g.approval_level_id,
    g.position,
    FALSE AS is_explicit
  FROM submitted_without_steps s
  JOIN document_global_approval_levels g ON g.organization_id=s.organization_id
  JOIN approval_levels al ON al.id=g.approval_level_id
   AND al.organization_id=s.organization_id
   AND al.is_active=TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM explicit_ladder e WHERE e.document_id=s.document_id
  )
), resolved AS (
  SELECT * FROM explicit_ladder
  UNION ALL
  SELECT * FROM global_ladder
), ranked AS (
  SELECT
    document_id,
    approval_level_id,
    ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY position, approval_level_id) AS step_no
  FROM resolved
)
INSERT INTO document_approvals(document_id, approval_level_id, sequence, status)
SELECT
  document_id,
  approval_level_id,
  step_no,
  CASE WHEN step_no=1 THEN 'PENDING' ELSE 'QUEUED' END
FROM ranked
ON CONFLICT DO NOTHING;

-- Backfill an unread request for current pending approvers. If a level has no
-- explicit assignee, Admin is the fallback approver. Admin creators are allowed
-- to receive their own request by default.
WITH pending AS (
  SELECT DISTINCT ON (da.document_id)
    da.document_id,
    da.approval_level_id,
    al.name AS approval_level_name,
    d.organization_id,
    d.entity_type,
    d.entity_id,
    d.title,
    d.created_by_user_id
  FROM document_approvals da
  JOIN documents d ON d.id=da.document_id
  JOIN approval_levels al ON al.id=da.approval_level_id
  WHERE da.status='PENDING'
    AND d.workflow_state_code='SUBMITTED'
  ORDER BY da.document_id, da.sequence
), eligible AS (
  SELECT DISTINCT p.*, u.id AS approver_user_id
  FROM pending p
  JOIN users u
    ON u.organization_id=p.organization_id
   AND u.status='active'
   AND u.is_system=FALSE
  WHERE EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id=ur.role_id AND r.organization_id=p.organization_id
    JOIN role_permissions rp ON rp.role_id=r.id
    JOIN permissions perm ON perm.id=rp.permission_id AND perm.code='approvals.act'
    WHERE ur.user_id=u.id
  )
  AND (
    EXISTS (
      SELECT 1 FROM approval_level_users alu
      WHERE alu.approval_level_id=p.approval_level_id
        AND alu.user_id=u.id
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM approval_level_users any_alu
        WHERE any_alu.approval_level_id=p.approval_level_id
      )
      AND EXISTS (
        SELECT 1
        FROM user_roles ur_admin
        JOIN roles r_admin ON r_admin.id=ur_admin.role_id
        WHERE ur_admin.user_id=u.id
          AND r_admin.organization_id=p.organization_id
          AND LOWER(r_admin.name) IN ('admin','administrator','super admin','owner')
      )
    )
  )
)
INSERT INTO notifications(
  organization_id, user_id, created_by_user_id,
  type, title, body, severity, entity_type, entity_id
)
SELECT
  e.organization_id,
  e.approver_user_id,
  e.created_by_user_id,
  'approval',
  COALESCE(e.title,'Document') || ' awaiting approval',
  COALESCE(e.title,'Document') || ' is awaiting your approval at ' || COALESCE(e.approval_level_name,'the current approval level') || '.',
  'info',
  e.entity_type,
  e.entity_id
FROM eligible e
WHERE NOT EXISTS (
  SELECT 1
  FROM notifications n
  WHERE n.organization_id=e.organization_id
    AND n.user_id=e.approver_user_id
    AND n.type='approval'
    AND n.entity_type IS NOT DISTINCT FROM e.entity_type
    AND n.entity_id IS NOT DISTINCT FROM e.entity_id
    AND n.read_at IS NULL
);

COMMIT;
