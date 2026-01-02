-- Ensure user emails are unique per organisation, not globally.

DO $$
BEGIN
  -- Drop the implicit unique constraint on users(email) from the initial schema.
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
EXCEPTION WHEN undefined_table THEN
  -- no-op
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_org_email
  ON users(organization_id, email);
