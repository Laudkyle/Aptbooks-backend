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
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  archived_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  finalized_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMP WITH TIME ZONE,
  archived_at TIMESTAMP WITH TIME ZONE,
  finalized_at TIMESTAMP WITH TIME ZONE,
  UNIQUE (forecast_id, version_no)
);

-- 3) First add scenario_key column to forecast_versions for backward compatibility
ALTER TABLE forecast_versions 
  ADD COLUMN IF NOT EXISTS scenario_key TEXT;

-- 4) Attach lines to versions (while keeping backward compatibility)
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

-- Drop existing constraint
ALTER TABLE forecast_lines 
DROP CONSTRAINT IF EXISTS forecast_lines_forecast_id_account_id_period_id_key;

-- Add new constraint including version_id
ALTER TABLE forecast_lines 
ADD CONSTRAINT forecast_lines_forecast_id_forcast_version_id_account_id_period_id_key 
UNIQUE (forecast_id, forecast_version_id, account_id, period_id);

-- updated_at trigger

-- Create the updated_at trigger function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create scenarios table
CREATE TABLE IF NOT EXISTS scenarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_default BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Create indexes (including partial unique indexes instead of constraints with WHERE)
CREATE UNIQUE INDEX IF NOT EXISTS idx_scenarios_org_code_unique 
    ON scenarios(organization_id, code) 
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scenarios_org_default_unique 
    ON scenarios(organization_id, is_default) 
    WHERE is_default = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scenarios_organization_id ON scenarios(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_scenarios_is_active ON scenarios(is_active) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_scenarios_code ON scenarios(code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_scenarios_deleted_at ON scenarios(deleted_at) WHERE deleted_at IS NOT NULL;

-- Add trigger for updated_at
DROP TRIGGER IF EXISTS update_scenarios_updated_at ON scenarios;
CREATE TRIGGER update_scenarios_updated_at
    BEFORE UPDATE ON scenarios
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger to ensure single default scenario
CREATE OR REPLACE FUNCTION ensure_single_default_scenario()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_default AND NEW.deleted_at IS NULL THEN
        UPDATE scenarios 
        SET is_default = false 
        WHERE organization_id = NEW.organization_id 
          AND id != NEW.id 
          AND is_default = true 
          AND deleted_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ensure_single_default_scenario ON scenarios;
CREATE TRIGGER ensure_single_default_scenario
    BEFORE INSERT OR UPDATE OF is_default ON scenarios
    FOR EACH ROW
    WHEN (NEW.is_default = true AND NEW.deleted_at IS NULL)
    EXECUTE FUNCTION ensure_single_default_scenario();

-- Modify forecast_versions table to reference scenarios
ALTER TABLE forecast_versions 
ADD COLUMN IF NOT EXISTS scenario_id UUID REFERENCES scenarios(id) ON DELETE SET NULL;

-- Create index for the new foreign key
CREATE INDEX IF NOT EXISTS idx_forecast_versions_scenario_id ON forecast_versions(scenario_id) WHERE scenario_id IS NOT NULL;

-- Migrate existing scenario_key data to scenarios table
INSERT INTO scenarios (organization_id, code, name, is_default, created_at)
SELECT DISTINCT 
    fv.organization_id,
    UPPER(TRIM(fv.scenario_key)) as code,
    INITCAP(TRIM(fv.scenario_key)) as name,
    false as is_default,
    NOW() as created_at
FROM forecast_versions fv
WHERE fv.scenario_key IS NOT NULL 
  AND TRIM(fv.scenario_key) != ''
  AND NOT EXISTS (
    SELECT 1 FROM scenarios s 
    WHERE s.organization_id = fv.organization_id 
      AND s.code = UPPER(TRIM(fv.scenario_key))
      AND s.deleted_at IS NULL
  );

-- Update forecast_versions to set scenario_id based on existing scenario_key
UPDATE forecast_versions fv
SET scenario_id = s.id
FROM scenarios s
WHERE fv.organization_id = s.organization_id 
  AND UPPER(TRIM(fv.scenario_key)) = s.code
  AND fv.scenario_key IS NOT NULL
  AND s.deleted_at IS NULL;

-- Now we can safely drop the scenario_key column after data migration
ALTER TABLE forecast_versions DROP COLUMN IF EXISTS scenario_key;

-- Add comments
COMMENT ON TABLE scenarios IS 'Forecast scenarios for scenario planning and what-if analysis';
COMMENT ON COLUMN scenarios.code IS 'Unique scenario code (e.g., BASE, OPTIMISTIC, CONSERVATIVE)';
COMMENT ON COLUMN scenarios.name IS 'Display name for the scenario';
COMMENT ON COLUMN scenarios.description IS 'Detailed description of the scenario assumptions';
COMMENT ON COLUMN scenarios.is_default IS 'Whether this is the default scenario for the organization';
COMMENT ON COLUMN scenarios.is_active IS 'Whether this scenario is available for use';
COMMENT ON COLUMN scenarios.metadata IS 'Additional scenario configuration data';
COMMENT ON COLUMN scenarios.deleted_at IS 'Soft delete timestamp';

-- Function to create default scenarios for new organizations
CREATE OR REPLACE FUNCTION create_default_scenarios()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO scenarios (organization_id, code, name, description, is_default, is_active)
    VALUES 
        (NEW.id, 'BASE', 'Base Case', 'Most likely scenario based on current trends and assumptions', true, true),
        (NEW.id, 'OPTIMISTIC', 'Optimistic', 'Best case scenario with favorable conditions', false, true),
        (NEW.id, 'PESSIMISTIC', 'Pessimistic', 'Worst case scenario with unfavorable conditions', false, true),
        (NEW.id, 'CONSERVATIVE', 'Conservative', 'Cautious scenario with conservative estimates', false, true),
        (NEW.id, 'AGGRESSIVE', 'Aggressive', 'Growth-oriented scenario with ambitious targets', false, true);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on organizations table
DROP TRIGGER IF EXISTS after_organization_create ON organizations;
CREATE TRIGGER after_organization_create
    AFTER INSERT ON organizations
    FOR EACH ROW
    EXECUTE FUNCTION create_default_scenarios();

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