BEGIN;

-- -----------------------------------------------------------------------------
-- Step 8: approval-request delivery + inclusive-tax detail hardening
-- -----------------------------------------------------------------------------

-- Credit/debit-note services have always calculated the taxable base, but the
-- original line schemas did not persist it. Persist it so detail rendering has
-- the same canonical net/tax/gross values as invoices, bills and operational
-- documents.
ALTER TABLE credit_note_lines
  ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(18,2);

ALTER TABLE debit_note_lines
  ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(18,2);

-- Backfill historical rows. line_total is the entered amount; for inclusive tax
-- the taxable/net base is line_total less the inclusive non-withholding
-- components. Exclusive components are added after that base and are not
-- subtracted here.
UPDATE credit_note_lines l
SET taxable_amount = GREATEST(
  COALESCE(l.line_total,0) - COALESCE(
    (
      SELECT SUM(d.tax_amount)
      FROM credit_note_line_tax_details d
      LEFT JOIN tax_codes tc ON tc.id = d.tax_code_id
      WHERE d.line_id = l.id
        AND COALESCE(UPPER(d.tax_type), '') <> 'WITHHOLDING'
        AND LOWER(COALESCE(tc.calculation_method, 'standard')) = 'inclusive'
    ),
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM tax_codes tc
        WHERE tc.id = l.tax_code_id
          AND LOWER(COALESCE(tc.calculation_method, 'standard')) = 'inclusive'
      ) THEN COALESCE(l.tax_amount,0)
      ELSE 0
    END
  ),
  0
)
WHERE taxable_amount IS NULL;

UPDATE debit_note_lines l
SET taxable_amount = GREATEST(
  COALESCE(l.line_total,0) - COALESCE(
    (
      SELECT SUM(d.tax_amount)
      FROM debit_note_line_tax_details d
      LEFT JOIN tax_codes tc ON tc.id = d.tax_code_id
      WHERE d.line_id = l.id
        AND COALESCE(UPPER(d.tax_type), '') <> 'WITHHOLDING'
        AND LOWER(COALESCE(tc.calculation_method, 'standard')) = 'inclusive'
    ),
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM tax_codes tc
        WHERE tc.id = l.tax_code_id
          AND LOWER(COALESCE(tc.calculation_method, 'standard')) = 'inclusive'
      ) THEN COALESCE(l.tax_amount,0)
      ELSE 0
    END
  ),
  0
)
WHERE taxable_amount IS NULL;

ALTER TABLE credit_note_lines
  ALTER COLUMN taxable_amount SET DEFAULT 0,
  ALTER COLUMN taxable_amount SET NOT NULL;

ALTER TABLE debit_note_lines
  ALTER COLUMN taxable_amount SET DEFAULT 0,
  ALTER COLUMN taxable_amount SET NOT NULL;

-- Existing submitted workflow documents created before Step 8 already have
-- PENDING approval rows but no per-user request/notification. Backfill those
-- requests for the current pending level. New submissions are handled inside
-- the submission transaction by documents.repository.js.
WITH pending AS (
  SELECT DISTINCT ON (da.document_id)
    da.document_id,
    da.approval_level_id,
    al.name AS approval_level_name,
    d.organization_id,
    d.document_type_id,
    d.entity_type,
    d.entity_id,
    d.title,
    d.created_by_user_id
  FROM document_approvals da
  JOIN documents d ON d.id = da.document_id
  JOIN approval_levels al ON al.id = da.approval_level_id
  WHERE da.status = 'PENDING'
    AND d.workflow_state_code = 'SUBMITTED'
  ORDER BY da.document_id, da.sequence ASC
), candidates AS (
  SELECT DISTINCT
    p.*,
    u.id AS approver_user_id,
    COALESCE(rule.allow_self_approval, FALSE) OR COALESCE(rule.creator_can_approve, FALSE) AS creator_may_approve
  FROM pending p
  JOIN users u
    ON u.organization_id = p.organization_id
   AND u.status = 'active'
   AND u.is_system = FALSE
  LEFT JOIN LATERAL (
    SELECT dws.allow_self_approval, dws.creator_can_approve
    FROM document_workflow_statics dws
    WHERE dws.organization_id = p.organization_id
      AND (dws.document_type_id = p.document_type_id OR dws.document_type_id IS NULL)
      AND (dws.entity_type = p.entity_type OR dws.entity_type IS NULL)
    ORDER BY
      CASE WHEN dws.document_type_id IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN dws.entity_type IS NOT NULL THEN 0 ELSE 1 END,
      dws.updated_at DESC,
      dws.created_at DESC
    LIMIT 1
  ) rule ON TRUE
  WHERE EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions perm ON perm.id = rp.permission_id
    WHERE ur.user_id = u.id
      AND r.organization_id = p.organization_id
      AND perm.code = 'approvals.act'
  )
  AND (
    NOT EXISTS (
      SELECT 1
      FROM approval_level_users alu_any
      WHERE alu_any.approval_level_id = p.approval_level_id
    )
    OR EXISTS (
      SELECT 1
      FROM approval_level_users alu_me
      WHERE alu_me.approval_level_id = p.approval_level_id
        AND alu_me.user_id = u.id
    )
  )
)
INSERT INTO notifications(
  organization_id, user_id, created_by_user_id,
  type, title, body, severity, entity_type, entity_id
)
SELECT
  c.organization_id,
  c.approver_user_id,
  c.created_by_user_id,
  'approval',
  COALESCE(c.title, 'Document') || ' awaiting approval',
  COALESCE(c.title, 'Document') || ' is awaiting your approval at ' || COALESCE(c.approval_level_name, 'the current approval level') || '.',
  'info',
  c.entity_type,
  c.entity_id
FROM candidates c
WHERE (c.creator_may_approve OR c.created_by_user_id IS NULL OR c.created_by_user_id IS DISTINCT FROM c.approver_user_id)
  AND NOT EXISTS (
    SELECT 1
    FROM notifications n
    WHERE n.organization_id = c.organization_id
      AND n.user_id = c.approver_user_id
      AND n.type = 'approval'
      AND n.entity_type IS NOT DISTINCT FROM c.entity_type
      AND n.entity_id IS NOT DISTINCT FROM c.entity_id
      AND n.read_at IS NULL
  );

COMMIT;
