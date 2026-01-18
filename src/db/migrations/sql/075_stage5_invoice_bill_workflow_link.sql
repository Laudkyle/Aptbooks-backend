-- 075_stage5_invoice_bill_workflow_link.sql
-- Stage 5: Link invoices/bills to Tier-10 documents workflow

BEGIN;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_workflow_document ON invoices(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_bills_workflow_document ON bills(workflow_document_id);

COMMIT;
