-- 102_stage5_phase34_inventory_and_ops_document_workflow.sql
-- Phase 3/4: inventory workflow-document links and receipt alias support

ALTER TABLE inventory_transactions
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_workflow_document
  ON inventory_transactions(workflow_document_id);

ALTER TABLE inventory_stock_counts
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

ALTER TABLE inventory_stock_counts DROP CONSTRAINT IF EXISTS inventory_stock_counts_status_check;
ALTER TABLE inventory_stock_counts ADD CONSTRAINT inventory_stock_counts_status_check
  CHECK (status IN ('draft','submitted','approved','rejected','posted','voided'));

CREATE INDEX IF NOT EXISTS idx_inventory_stock_counts_workflow_document
  ON inventory_stock_counts(workflow_document_id);
