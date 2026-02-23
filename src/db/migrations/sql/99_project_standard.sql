-- =====================================================
-- Migration: Update project tables with accounting standards
-- Date: 2026-02-23
-- =====================================================

BEGIN;

-- =====================================================
-- 1. First, update the status check constraints
-- =====================================================

-- Update projects table
ALTER TABLE projects 
  DROP CONSTRAINT IF EXISTS projects_status_check;

ALTER TABLE projects 
  ADD CONSTRAINT projects_status_check 
  CHECK (status IN ('draft', 'active', 'on_hold', 'completed', 'archived'));

-- Update existing 'inactive' records to appropriate status
-- You'll need to decide how to map existing statuses
UPDATE projects 
SET status = 'draft' 
WHERE status = 'inactive';

UPDATE projects 
SET status = 'on_hold' 
WHERE status = 'inactive'; -- Or map to 'on_hold' if that's more appropriate

-- Update project_phases table
ALTER TABLE project_phases 
  DROP CONSTRAINT IF EXISTS project_phases_status_check;

ALTER TABLE project_phases 
  ADD CONSTRAINT project_phases_status_check 
  CHECK (status IN ('draft', 'active', 'on_hold', 'completed', 'archived'));

-- Map existing 'closed' to 'completed'
UPDATE project_phases 
SET status = 'completed' 
WHERE status = 'closed';

-- Map any 'inactive' to appropriate status
UPDATE project_phases 
SET status = 'draft' 
WHERE status = 'inactive';

-- Update project_tasks table
ALTER TABLE project_tasks 
  DROP CONSTRAINT IF EXISTS project_tasks_status_check;

ALTER TABLE project_tasks 
  ADD CONSTRAINT project_tasks_status_check 
  CHECK (status IN ('draft', 'active', 'on_hold', 'completed', 'archived'));

-- Map existing 'closed' to 'completed'
UPDATE project_tasks 
SET status = 'completed' 
WHERE status = 'closed';

-- Map any 'inactive' to appropriate status
UPDATE project_tasks 
SET status = 'draft' 
WHERE status = 'inactive';

-- =====================================================
-- 2. Add new columns to tables
-- =====================================================

-- Add columns to projects (if they don't exist)
DO $$ 
BEGIN
  -- Add description if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'projects' AND column_name = 'description'
  ) THEN
    ALTER TABLE projects ADD COLUMN description TEXT;
  END IF;

  -- Add created_at if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'projects' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE projects ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;

  -- Add updated_at if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'projects' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE projects ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;

-- Add columns to project_phases
DO $$ 
BEGIN
  -- Add description if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_phases' AND column_name = 'description'
  ) THEN
    ALTER TABLE project_phases ADD COLUMN description TEXT;
  END IF;

  -- Add start_date if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_phases' AND column_name = 'start_date'
  ) THEN
    ALTER TABLE project_phases ADD COLUMN start_date DATE;
  END IF;

  -- Add end_date if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_phases' AND column_name = 'end_date'
  ) THEN
    ALTER TABLE project_phases ADD COLUMN end_date DATE;
  END IF;

  -- Add created_at if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_phases' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE project_phases ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;

  -- Add updated_at if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_phases' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE project_phases ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;

-- Add columns to project_tasks
DO $$ 
BEGIN
  -- Add description if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'description'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN description TEXT;
  END IF;

  -- Add code if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'code'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN code TEXT;
  END IF;

  -- Add priority if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'priority'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN priority TEXT DEFAULT 'medium';
  END IF;

  -- Add assigned_to if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'assigned_to'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN assigned_to UUID;
  END IF;

  -- Add estimated_hours if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'estimated_hours'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN estimated_hours NUMERIC(10,2);
  END IF;

  -- Add actual_hours if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'actual_hours'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN actual_hours NUMERIC(10,2);
  END IF;

  -- Add completed_date if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'completed_date'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN completed_date DATE;
  END IF;

  -- Add start_date if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'start_date'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN start_date DATE;
  END IF;

  -- Add end_date if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'end_date'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN end_date DATE;
  END IF;

  -- Add created_at if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;

  -- Add updated_at if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'project_tasks' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;

-- =====================================================
-- 3. Add constraints to new columns
-- =====================================================

-- Add priority check constraint
ALTER TABLE project_tasks 
  DROP CONSTRAINT IF EXISTS project_tasks_priority_check;

ALTER TABLE project_tasks 
  ADD CONSTRAINT project_tasks_priority_check 
  CHECK (priority IN ('low', 'medium', 'high', 'critical'));

-- Add unique constraint for task code if it exists and not null
-- First, clean up any null codes or duplicates
UPDATE project_tasks SET code = name WHERE code IS NULL;

-- Then add unique constraint (will fail if there are duplicates)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'project_tasks_organization_id_project_id_code_key'
  ) THEN
    -- You might need to handle duplicates before adding this
    -- This is a soft attempt - if it fails, you'll need to clean duplicates first
    BEGIN
      ALTER TABLE project_tasks 
        ADD CONSTRAINT project_tasks_organization_id_project_id_code_key 
        UNIQUE (organization_id, project_id, code);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not add unique constraint on tasks.code - check for duplicates';
    END;
  END IF;
END $$;

-- =====================================================
-- 4. Create indexes for performance
-- =====================================================

-- Projects indexes
CREATE INDEX IF NOT EXISTS idx_projects_organization_id ON projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_dates ON projects(start_date, end_date);

-- Project phases indexes
CREATE INDEX IF NOT EXISTS idx_project_phases_project_id ON project_phases(project_id);
CREATE INDEX IF NOT EXISTS idx_project_phases_status ON project_phases(status);
CREATE INDEX IF NOT EXISTS idx_project_phases_sort_order ON project_phases(sort_order);

-- Project tasks indexes
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_phase_id ON project_tasks(phase_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_status ON project_tasks(status);
CREATE INDEX IF NOT EXISTS idx_project_tasks_assigned_to ON project_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_project_tasks_priority ON project_tasks(priority);
CREATE INDEX IF NOT EXISTS idx_project_tasks_dates ON project_tasks(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_project_tasks_sort_order ON project_tasks(sort_order);

-- =====================================================
-- 5. Create view for project progress
-- =====================================================

CREATE OR REPLACE VIEW project_progress AS
SELECT 
  p.id AS project_id,
  p.name AS project_name,
  p.status AS project_status,
  COUNT(DISTINCT ph.id) AS total_phases,
  COUNT(DISTINCT CASE WHEN ph.status = 'completed' THEN ph.id END) AS completed_phases,
  COUNT(DISTINCT t.id) AS total_tasks,
  COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) AS completed_tasks,
  SUM(t.estimated_hours) AS total_estimated_hours,
  SUM(t.actual_hours) AS total_actual_hours,
  CASE 
    WHEN SUM(t.estimated_hours) > 0 
    THEN ROUND((SUM(t.actual_hours) / SUM(t.estimated_hours) * 100)::NUMERIC, 2)
    ELSE 0 
  END AS hours_completion_percentage
FROM projects p
LEFT JOIN project_phases ph ON p.id = ph.project_id
LEFT JOIN project_tasks t ON p.id = t.project_id
GROUP BY p.id, p.name, p.status;

-- =====================================================
-- 6. Add comments for documentation
-- =====================================================

COMMENT ON TABLE projects IS 'Projects for financial tracking and dimensional reporting';
COMMENT ON TABLE project_phases IS 'Project phases that group related tasks';
COMMENT ON TABLE project_tasks IS 'Individual tasks within project phases for detailed tracking';

COMMENT ON COLUMN projects.status IS 'draft=planning, active=running, on_hold=paused, completed=finished, archived=historical';
COMMENT ON COLUMN project_phases.status IS 'draft=planning, active=in_progress, on_hold=paused, completed=finished, archived=historical';
COMMENT ON COLUMN project_tasks.status IS 'draft=planning, active=in_progress, on_hold=paused, completed=finished, archived=historical';
COMMENT ON COLUMN project_tasks.priority IS 'Task priority for scheduling: low, medium, high, critical';
COMMENT ON COLUMN project_tasks.estimated_hours IS 'Planned hours for the task';
COMMENT ON COLUMN project_tasks.actual_hours IS 'Actual hours logged against the task';

-- =====================================================
-- 7. Create trigger for updating updated_at
-- =====================================================

-- Create function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Drop and recreate triggers for each table
DROP TRIGGER IF EXISTS update_projects_updated_at ON projects;
CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_project_phases_updated_at ON project_phases;
CREATE TRIGGER update_project_phases_updated_at
    BEFORE UPDATE ON project_phases
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_project_tasks_updated_at ON project_tasks;
CREATE TRIGGER update_project_tasks_updated_at
    BEFORE UPDATE ON project_tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;

-- =====================================================
-- 8. Verification queries (run these after migration)
-- =====================================================

/*
-- Check status distributions
SELECT status, COUNT(*) FROM projects GROUP BY status;
SELECT status, COUNT(*) FROM project_phases GROUP BY status;
SELECT status, COUNT(*) FROM project_tasks GROUP BY status;

-- Check new columns
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'project_tasks' 
ORDER BY ordinal_position;
*/