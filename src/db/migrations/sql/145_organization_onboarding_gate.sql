-- Step 4: mandatory first-run setup for newly created organizations.
-- Existing organizations are explicitly grandfathered; after this migration,
-- every newly inserted organization defaults to onboarding_required=TRUE.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS onboarding_required BOOLEAN,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_completed_by_user_id UUID;

-- Grandfather organizations that existed before this migration.
UPDATE organizations
   SET onboarding_required=FALSE
 WHERE onboarding_required IS NULL;

ALTER TABLE organizations
  ALTER COLUMN onboarding_required SET DEFAULT TRUE,
  ALTER COLUMN onboarding_required SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_organizations_onboarding_completed_by'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT fk_organizations_onboarding_completed_by
      FOREIGN KEY (onboarding_completed_by_user_id)
      REFERENCES users(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_organizations_onboarding_required
  ON organizations(onboarding_required)
  WHERE onboarding_required = TRUE;
