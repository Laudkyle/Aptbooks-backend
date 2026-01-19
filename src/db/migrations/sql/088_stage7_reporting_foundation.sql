-- Stage 7 (Reporting & Planning) - Stage 1 Foundation
-- Governance hardening for centers and projects.

-- 1) Centers: lifecycle governance

-- Expand allowed statuses to include 'archived'
ALTER TABLE cost_centers DROP CONSTRAINT IF EXISTS cost_centers_status_check;
ALTER TABLE profit_centers DROP CONSTRAINT IF EXISTS profit_centers_status_check;
ALTER TABLE investment_centers DROP CONSTRAINT IF EXISTS investment_centers_status_check;

ALTER TABLE cost_centers
  ADD CONSTRAINT cost_centers_status_check CHECK (status IN ('active','inactive','archived'));
ALTER TABLE profit_centers
  ADD CONSTRAINT profit_centers_status_check CHECK (status IN ('active','inactive','archived'));
ALTER TABLE investment_centers
  ADD CONSTRAINT investment_centers_status_check CHECK (status IN ('active','inactive','archived'));

-- Add lifecycle and hierarchy fields (nullable for backwards compatibility)
ALTER TABLE cost_centers
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES cost_centers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS valid_from DATE,
  ADD COLUMN IF NOT EXISTS valid_to DATE,
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

ALTER TABLE profit_centers
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES profit_centers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS valid_from DATE,
  ADD COLUMN IF NOT EXISTS valid_to DATE,
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

ALTER TABLE investment_centers
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES investment_centers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS valid_from DATE,
  ADD COLUMN IF NOT EXISTS valid_to DATE,
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_cost_centers_parent ON cost_centers(parent_id);
CREATE INDEX IF NOT EXISTS idx_profit_centers_parent ON profit_centers(parent_id);
CREATE INDEX IF NOT EXISTS idx_investment_centers_parent ON investment_centers(parent_id);

-- 2) Projects: align phases/tasks tables with services

-- project_phases: add code and timestamps if missing
ALTER TABLE project_phases
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- project_tasks: add code and timestamps if missing
ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Ensure uniqueness of codes within project for better governance (best-effort; can be refined later)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_project_phases_org_project_code_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_project_phases_org_project_code_unique
      ON project_phases(organization_id, project_id, code)
      WHERE code IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_project_tasks_org_project_phase_code_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_project_tasks_org_project_phase_code_unique
      ON project_tasks(organization_id, project_id, phase_id, code)
      WHERE code IS NOT NULL;
  END IF;
END $$;
