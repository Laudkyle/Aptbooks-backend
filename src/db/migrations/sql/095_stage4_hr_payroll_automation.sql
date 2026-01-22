-- Stage 4: HR Payroll Automation (Statutory/Benefits base selection, caps, and HR import/export support)

-- Add base selection and cap to benefit plans
ALTER TABLE hr_benefit_plans
  ADD COLUMN IF NOT EXISTS base_on TEXT NOT NULL DEFAULT 'base' CHECK (base_on IN ('base','gross')),
  ADD COLUMN IF NOT EXISTS cap_amount NUMERIC(18,2);

-- Add base selection and cap to statutory rules
ALTER TABLE hr_statutory_rules
  ADD COLUMN IF NOT EXISTS base_on TEXT NOT NULL DEFAULT 'base' CHECK (base_on IN ('base','gross')),
  ADD COLUMN IF NOT EXISTS cap_amount NUMERIC(18,2);

-- Optional permissions (kept granular for enterprise setups)
INSERT INTO permissions (code, description) VALUES
  ('hr.employees.import', 'Import employees in bulk'),
  ('hr.employees.export', 'Export employees in bulk')
ON CONFLICT (code) DO NOTHING;
