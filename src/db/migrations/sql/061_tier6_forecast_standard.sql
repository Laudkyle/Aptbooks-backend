-- Tier 6: Forecasts standardisation (versions + proper status)

-- 1) Allow draft status on forecasts
DO $$
BEGIN
  -- Drop old check constraint if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'forecasts_status_check'
  ) THEN
    ALTER TABLE forecasts DROP CONSTRAINT forecasts_status_check;
  END IF;
END $$;

ALTER TABLE forecasts
  ADD CONSTRAINT forecasts_status_check CHECK (status IN ('draft','active','archived'));

-- 2) Forecast versions
CREATE TABLE IF NOT EXISTS forecast_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  forecast_id UUID NOT NULL REFERENCES forecasts(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','archived')),
  created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (forecast_id, version_no)
);

-- 3) Attach lines to versions (while keeping backward compatibility)
ALTER TABLE forecast_lines
  ADD COLUMN IF NOT EXISTS forecast_version_id UUID NULL REFERENCES forecast_versions(id) ON DELETE CASCADE;

-- Create a default v1 for any existing forecast and attach existing lines.
WITH ins AS (
  INSERT INTO forecast_versions (organization_id, forecast_id, version_no, name, status)
  SELECT f.organization_id, f.id, 1, 'Base Version', 'draft'
  FROM forecasts f
  WHERE NOT EXISTS (
    SELECT 1 FROM forecast_versions v WHERE v.forecast_id = f.id AND v.version_no = 1
  )
  RETURNING forecast_id, id
)
UPDATE forecast_lines fl
SET forecast_version_id = v.id
FROM forecast_versions v
WHERE fl.forecast_id = v.forecast_id
  AND v.version_no = 1
  AND fl.forecast_version_id IS NULL;

-- Enforce uniqueness per version (recommended for upserts)
CREATE UNIQUE INDEX IF NOT EXISTS ux_forecast_version_lines
  ON forecast_lines (forecast_version_id, account_id, period_id)
  WHERE forecast_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_forecast_versions_forecast
  ON forecast_versions (organization_id, forecast_id);

-- updated_at trigger
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    -- Create trigger only if missing
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'tr_forecast_versions_updated_at'
    ) THEN
      CREATE TRIGGER tr_forecast_versions_updated_at
      BEFORE UPDATE ON forecast_versions
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
    END IF;
  END IF;
END $$;
