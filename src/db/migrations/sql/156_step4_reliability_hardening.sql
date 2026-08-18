-- Step 4: transaction reliability, idempotency leases, scheduler lifecycle,
-- and immediate access-token revocation support.

BEGIN;

-- ---------------------------------------------------------------------------
-- API idempotency: recoverable leases rather than permanent IN_PROGRESS rows.
-- ---------------------------------------------------------------------------
ALTER TABLE api_idempotency_keys
  ADD COLUMN IF NOT EXISTS owner_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

UPDATE api_idempotency_keys
   SET attempt_count = CASE WHEN attempt_count < 1 THEN 1 ELSE attempt_count END
 WHERE status IN ('IN_PROGRESS','COMPLETED','FAILED');

-- Old IN_PROGRESS rows have no valid lease and are intentionally reclaimable.
UPDATE api_idempotency_keys
   SET lease_expires_at = COALESCE(lease_expires_at, NOW() - INTERVAL '1 second')
 WHERE status='IN_PROGRESS';

CREATE INDEX IF NOT EXISTS ix_api_idempotency_reclaim
  ON api_idempotency_keys(status, lease_expires_at)
  WHERE status='IN_PROGRESS';

-- ---------------------------------------------------------------------------
-- Access-token version. Incrementing this invalidates every issued access token
-- for the user immediately; auth middleware also verifies live org membership.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_auth_version_positive;
ALTER TABLE users
  ADD CONSTRAINT users_auth_version_positive CHECK (auth_version > 0);

-- ---------------------------------------------------------------------------
-- Shared operational documents: persist reversal linkage and void rationale so
-- a void is a durable accounting transition rather than an HTTP-only state.
-- ---------------------------------------------------------------------------
ALTER TABLE operational_documents
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_operational_documents_reversal_journal
  ON operational_documents(organization_id, reversal_journal_entry_id)
  WHERE reversal_journal_entry_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Scheduler execution lifecycle. A run is inserted once and transitioned in
-- place from running -> success|failed|skipped.
-- ---------------------------------------------------------------------------
ALTER TABLE scheduled_task_runs
  ADD COLUMN IF NOT EXISTS runner_id TEXT,
  ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE scheduled_task_runs
  DROP CONSTRAINT IF EXISTS scheduled_task_runs_trigger_type_check;
ALTER TABLE scheduled_task_runs
  ADD CONSTRAINT scheduled_task_runs_trigger_type_check
  CHECK (trigger_type IN ('scheduled','manual'));

CREATE INDEX IF NOT EXISTS idx_task_runs_running
  ON scheduled_task_runs(task_code, started_at)
  WHERE status='running';

COMMIT;
