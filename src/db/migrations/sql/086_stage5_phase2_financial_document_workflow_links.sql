-- 086_stage5_phase2_financial_document_workflow_links.sql
-- Phase 2: document workflow links for high-value financial documents

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE credit_notes
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE credit_notes DROP CONSTRAINT IF EXISTS credit_notes_status_check;
ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_status_check
  CHECK (status IN ('draft','submitted','approved','rejected','issued','voided'));

ALTER TABLE debit_notes
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE debit_notes DROP CONSTRAINT IF EXISTS debit_notes_status_check;
ALTER TABLE debit_notes ADD CONSTRAINT debit_notes_status_check
  CHECK (status IN ('draft','submitted','approved','rejected','issued','voided'));

ALTER TABLE vendor_payments
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE vendor_payments DROP CONSTRAINT IF EXISTS vendor_payments_status_check;
ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_status_check
  CHECK (status IN ('draft','submitted','approved','rejected','posted','voided'));

ALTER TABLE customer_receipts
  ADD COLUMN IF NOT EXISTS workflow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE customer_receipts DROP CONSTRAINT IF EXISTS customer_receipts_status_check;
ALTER TABLE customer_receipts ADD CONSTRAINT customer_receipts_status_check
  CHECK (status IN ('draft','submitted','approved','rejected','posted','voided'));

CREATE INDEX IF NOT EXISTS idx_journal_entries_workflow_document ON journal_entries(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_workflow_document ON credit_notes(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_debit_notes_workflow_document ON debit_notes(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_workflow_document ON vendor_payments(workflow_document_id);
CREATE INDEX IF NOT EXISTS idx_customer_receipts_workflow_document ON customer_receipts(workflow_document_id);
