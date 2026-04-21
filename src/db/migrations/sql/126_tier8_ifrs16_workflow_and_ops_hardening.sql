
-- 126_tier8_ifrs16_workflow_and_ops_hardening.sql
-- Adds workflow-document support and richer lifecycle audit columns for IFRS 16 leases and modifications.

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

ALTER TABLE lease_modifications
  DROP CONSTRAINT IF EXISTS lease_modifications_status_check;
ALTER TABLE lease_modifications
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE lease_modifications
  ADD CONSTRAINT lease_modifications_status_check
  CHECK (status IN ('draft','submitted','approved','rejected','applied','voided'));

CREATE INDEX IF NOT EXISTS idx_leases_workflow_document ON leases(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_lease_modifications_workflow_document ON lease_modifications(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_lease_payments_org_lease_due ON lease_payments(organization_id, lease_id, due_date);
CREATE INDEX IF NOT EXISTS idx_lease_modifications_org_lease_status ON lease_modifications(organization_id, lease_id, status, effective_date DESC);
