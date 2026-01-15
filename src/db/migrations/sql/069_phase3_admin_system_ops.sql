-- Phase 3: Administration & System Operations
-- Adds org profile/branding fields, API keys, error log storage, audit export scheduling,
-- login history, and 2FA-related user columns.

BEGIN;

-- Organizations: profile & branding
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS address_json jsonb,
  ADD COLUMN IF NOT EXISTS branding_json jsonb,
  ADD COLUMN IF NOT EXISTS logo_document_id uuid;

-- Users: profile + 2FA + login markers
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS two_factor_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS two_factor_secret text,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_ip text,
  ADD COLUMN IF NOT EXISTS last_login_user_agent text;

-- Some installations may have a CHECK constraint for users.status; widen it safely.
DO $$
DECLARE
  c_name text;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'users'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%'
  LIMIT 1;

  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c_name);
  END IF;

  -- Recreate a permissive constraint (active/disabled/deleted) if status column exists.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='status') THEN
    ALTER TABLE users
      ADD CONSTRAINT users_status_check CHECK (status IN ('active','disabled','deleted'));
  END IF;
END $$;

-- Login history
CREATE TABLE IF NOT EXISTS login_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid,
  email text,
  success boolean NOT NULL,
  ip text,
  user_agent text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_history_org_created_idx ON login_history(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS login_history_user_created_idx ON login_history(user_id, created_at DESC);

-- API keys
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid,
  name text NOT NULL,
  prefix text NOT NULL,
  secret_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_org_prefix_uq ON api_keys(organization_id, prefix);
CREATE INDEX IF NOT EXISTS api_keys_org_active_idx ON api_keys(organization_id, is_active);

-- Error log storage
CREATE TABLE IF NOT EXISTS error_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  correlation_id text,
  path text,
  method text,
  status int,
  message text,
  stack text,
  ip text,
  user_agent text,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_logs_created_idx ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS error_logs_corr_idx ON error_logs(correlation_id);

-- Audit export schedules
CREATE TABLE IF NOT EXISTS audit_export_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL,
  name text NOT NULL,
  filters_json jsonb,
  cron text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_export_schedules_org_idx ON audit_export_schedules(organization_id);

COMMIT;
