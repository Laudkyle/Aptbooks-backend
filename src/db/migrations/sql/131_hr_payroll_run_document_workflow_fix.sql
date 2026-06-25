-- HR payroll run document workflow alignment
-- - Payroll runs are batch-level documents, not employee payslips.
-- - Creates PAYROLL_RUN document types for all organizations.
-- - Copies existing PAYSLIP approval ladder/rules to PAYROLL_RUN where available.
-- - Re-labels existing payroll-run workflow documents that were incorrectly stored as payslip.

INSERT INTO document_types (organization_id, code, name, description, is_active)
SELECT o.id, 'PAYROLL_RUN', 'Payroll Run', 'Payroll batch/run approval document', TRUE
FROM organizations o
ON CONFLICT (organization_id, code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_active = TRUE;

-- Preserve existing PAYSLIP approval configuration by copying it to PAYROLL_RUN
-- only when PAYROLL_RUN has no explicit ladder configured yet.
INSERT INTO document_type_approval_levels (document_type_id, approval_level_id, position)
SELECT pr.id, dtal.approval_level_id, dtal.position
FROM document_types pr
JOIN document_types ps
  ON ps.organization_id = pr.organization_id
 AND ps.code = 'PAYSLIP'
JOIN document_type_approval_levels dtal
  ON dtal.document_type_id = ps.id
WHERE pr.code = 'PAYROLL_RUN'
  AND NOT EXISTS (
    SELECT 1
    FROM document_type_approval_levels existing
    WHERE existing.document_type_id = pr.id
  )
ON CONFLICT DO NOTHING;

-- Copy PAYSLIP-specific workflow statics to PAYROLL_RUN where PAYROLL_RUN does not yet have one.
INSERT INTO document_workflow_statics (
  organization_id,
  document_type_id,
  entity_type,
  creator_can_approve,
  creator_can_post,
  allow_self_approval,
  require_comment_on_rejection,
  notify_creator_on_approval,
  notify_creator_on_rejection,
  created_by_user_id,
  updated_by_user_id
)
SELECT
  dws.organization_id,
  pr.id,
  'payroll_run',
  dws.creator_can_approve,
  dws.creator_can_post,
  dws.allow_self_approval,
  dws.require_comment_on_rejection,
  dws.notify_creator_on_approval,
  dws.notify_creator_on_rejection,
  dws.created_by_user_id,
  dws.updated_by_user_id
FROM document_workflow_statics dws
JOIN document_types ps
  ON ps.id = dws.document_type_id
 AND ps.code = 'PAYSLIP'
JOIN document_types pr
  ON pr.organization_id = ps.organization_id
 AND pr.code = 'PAYROLL_RUN'
WHERE NOT EXISTS (
  SELECT 1
  FROM document_workflow_statics existing
  WHERE existing.organization_id = dws.organization_id
    AND existing.document_type_id = pr.id
    AND existing.entity_type = 'payroll_run'
)
ON CONFLICT (organization_id, document_type_id, entity_type) DO NOTHING;

-- Existing workflow documents created by the earlier HR payroll code used entity_type='payslip'
-- even though the entity id points to hr_payroll_runs. Reclassify those documents.
UPDATE documents d
SET entity_type = 'payroll_run',
    document_type_id = pr.id,
    title = COALESCE(NULLIF(d.title, ''), 'Payroll Run ' || d.entity_id::text),
    updated_at = NOW()
FROM hr_payroll_runs r
JOIN document_types pr
  ON pr.organization_id = r.organization_id
 AND pr.code = 'PAYROLL_RUN'
WHERE d.organization_id = r.organization_id
  AND d.entity_id = r.id
  AND d.entity_type = 'payslip';
