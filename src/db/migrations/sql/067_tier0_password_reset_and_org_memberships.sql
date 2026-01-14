-- Tier 0 extension: password reset flow + multi-org memberships
-- Adds:
--   1) user_organizations (many-to-many memberships)
--   2) password_reset_tokens (hashed, expiring, single-use)

CREATE TABLE IF NOT EXISTS user_organizations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, organization_id)
);

-- Backfill membership for existing users
INSERT INTO user_organizations(user_id, organization_id)
SELECT id, organization_id FROM users
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip INET NULL,
  user_agent TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
  ON password_reset_tokens(expires_at);
