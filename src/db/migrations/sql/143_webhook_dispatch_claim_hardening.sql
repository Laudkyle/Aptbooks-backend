BEGIN;

-- Durable worker claims prevent concurrent dispatchers from delivering the same
-- outbox event. A stale claim can be recovered after the worker lease expires.
ALTER TABLE webhook_outbox
  ADD COLUMN IF NOT EXISTS claim_token UUID NULL,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_processing_claim
  ON webhook_outbox (status, claimed_at)
  WHERE status='processing';

COMMIT;
