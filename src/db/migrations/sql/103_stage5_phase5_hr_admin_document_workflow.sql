-- Phase 5: HR and administrative workflow document links

ALTER TABLE hr_payroll_runs
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE hr_leave_requests
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

UPDATE hr_leave_requests
SET workflow_document_id = COALESCE(workflow_document_id, document_id)
WHERE document_id IS NOT NULL;

ALTER TABLE budget_versions
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE forecast_versions
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE ifrs15_contracts
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_workflow_document_id
  ON hr_payroll_runs(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_hr_leave_requests_workflow_document_id
  ON hr_leave_requests(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_budget_versions_workflow_document_id
  ON budget_versions(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_forecast_versions_workflow_document_id
  ON forecast_versions(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_projects_workflow_document_id
  ON projects(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_ifrs15_contracts_workflow_document_id
  ON ifrs15_contracts(workflow_document_id);
