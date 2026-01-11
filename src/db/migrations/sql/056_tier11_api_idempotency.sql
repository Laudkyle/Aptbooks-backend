-- Tier 11: API Idempotency Keys
-- Provides retry-safe semantics for write endpoints.

CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idem_key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS', -- IN_PROGRESS | COMPLETED | FAILED
  response_code INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_idempotency_keys_org_key_method_path
  ON api_idempotency_keys(organization_id, idem_key, method, path);

CREATE INDEX IF NOT EXISTS ix_api_idempotency_keys_org_created
  ON api_idempotency_keys(organization_id, created_at DESC);
