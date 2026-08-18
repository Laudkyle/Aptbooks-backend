-- Step 1 security hardening: custom SQL saved reports are no longer executable.
-- Disable schedules whose selected/latest version is SQL so the background
-- scheduler does not repeatedly attempt a definition that the application now
-- rejects for tenant-isolation reasons.

UPDATE saved_report_schedules s
SET is_enabled = FALSE,
    updated_at = NOW()
WHERE is_enabled = TRUE
  AND (
    EXISTS (
      SELECT 1
      FROM saved_report_versions v
      WHERE v.id = s.version_id
        AND v.organization_id = s.organization_id
        AND v.saved_report_id = s.saved_report_id
        AND v.kind = 'sql'
    )
    OR (
      s.version_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM saved_report_versions v
        WHERE v.organization_id = s.organization_id
          AND v.saved_report_id = s.saved_report_id
          AND v.kind = 'sql'
          AND v.version_number = (
            SELECT MAX(v2.version_number)
            FROM saved_report_versions v2
            WHERE v2.organization_id = s.organization_id
              AND v2.saved_report_id = s.saved_report_id
          )
      )
    )
  );
