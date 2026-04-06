BEGIN;

ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS signature_image text,
  ADD COLUMN IF NOT EXISTS signature_display_name text,
  ADD COLUMN IF NOT EXISTS signature_title text,
  ADD COLUMN IF NOT EXISTS signature_notes text,
  ADD COLUMN IF NOT EXISTS signature_is_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signature_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS signature_updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_org_signatures_active
  ON user_organizations(organization_id, signature_is_active)
  WHERE signature_is_active = TRUE;

COMMIT;
