-- Align HR payroll run statuses with the payroll approval workflow.
-- Earlier payroll runs only allowed draft/calculated/posted/voided, but the service
-- and routes use submitted/approved/rejected before posting.

ALTER TABLE hr_payroll_runs
  DROP CONSTRAINT IF EXISTS hr_payroll_runs_status_check;

ALTER TABLE hr_payroll_runs
  ADD CONSTRAINT hr_payroll_runs_status_check
  CHECK (status IN ('draft','calculated','submitted','approved','rejected','posted','voided'));

CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_org_status
  ON hr_payroll_runs(organization_id, status);
