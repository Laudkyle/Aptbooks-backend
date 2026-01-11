-- Tier 0: Refresh token storage for session management (A3)
-- Stores hashed refresh tokens for rotation + revocation.
-- Uses uuid-ossp extension already created in earlier migrations.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  family_id UUID NOT NULL,
  token_jti UUID NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,

  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,

  revoked_at TIMESTAMPTZ NULL,
  replaced_by_jti UUID NULL,

  ip TEXT NULL,
  user_agent TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_org_user ON refresh_tokens(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
