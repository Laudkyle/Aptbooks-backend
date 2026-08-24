BEGIN;

-- Phase 4 operational reliability. These indexes support bounded operational
-- queries used during incidents without introducing a second financial truth.
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status_started
  ON scheduled_task_runs(status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_logs_status_created
  ON error_logs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_financial_integrity_runs_org_status_created
  ON financial_integrity_runs(organization_id, status, created_at DESC);

COMMENT ON INDEX idx_scheduled_task_runs_status_started IS
  'Phase 4 incident-response index for recent scheduler failures.';
COMMENT ON INDEX idx_error_logs_status_created IS
  'Phase 4 incident-response index for recent HTTP/application errors.';
COMMENT ON INDEX idx_financial_integrity_runs_org_status_created IS
  'Phase 4 operational index for latest per-tenant financial assurance status.';

COMMIT;
