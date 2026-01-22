-- Stage 5: PAYE progressive brackets + Employee CSV import support

-- Extend statutory rules to support progressive tax tables (PAYE)
ALTER TABLE hr_statutory_rules
  ADD COLUMN IF NOT EXISTS calculation_method TEXT NOT NULL DEFAULT 'flat'
    CHECK (calculation_method IN ('flat','progressive')),
  ADD COLUMN IF NOT EXISTS brackets_json JSONB,
  ADD COLUMN IF NOT EXISTS allowance_amount NUMERIC(18,2) NOT NULL DEFAULT 0;

-- New permissions (optional but recommended)
INSERT INTO permissions (code, description) VALUES
  ('hr.employees.import_csv', 'Import employees from CSV (text/csv)'),
  ('hr.statutory.manage_brackets', 'Manage statutory bracket tables (PAYE)')
ON CONFLICT (code) DO NOTHING;
