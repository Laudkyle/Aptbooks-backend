-- Stage 6: HR bulk import/export permissions, payroll payout exports, and effective-dated statutory rules

-- Effective dating on statutory rules
ALTER TABLE hr_statutory_rules
  ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS effective_to DATE;

ALTER TABLE hr_statutory_rules
  DROP CONSTRAINT IF EXISTS chk_hr_statutory_rules_effective_range;
ALTER TABLE hr_statutory_rules
  ADD CONSTRAINT chk_hr_statutory_rules_effective_range CHECK (effective_to IS NULL OR effective_to >= effective_from);

CREATE INDEX IF NOT EXISTS idx_hr_statutory_rules_org_code_effective
  ON hr_statutory_rules(organization_id, code, effective_from, effective_to);

-- Permissions
INSERT INTO permissions (code, description) VALUES
  ('hr.departments.export', 'Export HR departments'),
  ('hr.departments.import', 'Import HR departments (JSON)'),
  ('hr.departments.import_csv', 'Import HR departments (CSV)'),

  ('hr.grades.export', 'Export HR grades'),
  ('hr.grades.import', 'Import HR grades (JSON)'),
  ('hr.grades.import_csv', 'Import HR grades (CSV)'),

  ('hr.positions.export', 'Export HR positions'),
  ('hr.positions.import', 'Import HR positions (JSON)'),
  ('hr.positions.import_csv', 'Import HR positions (CSV)'),

  ('hr.compensation_bands.export', 'Export HR compensation bands'),
  ('hr.compensation_bands.import', 'Import HR compensation bands (JSON)'),
  ('hr.compensation_bands.import_csv', 'Import HR compensation bands (CSV)'),

  ('hr.benefits.export', 'Export HR benefit plans'),
  ('hr.benefits.import', 'Import HR benefit plans (JSON)'),
  ('hr.benefits.import_csv', 'Import HR benefit plans (CSV)'),

  ('hr.statutory.export', 'Export HR statutory rules'),
  ('hr.statutory.import', 'Import HR statutory rules (JSON)'),
  ('hr.statutory.import_csv', 'Import HR statutory rules (CSV)'),

  ('hr.payroll.export', 'Export payroll payout files (net pay / bank)')
ON CONFLICT (code) DO NOTHING;
