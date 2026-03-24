BEGIN;

-- Extend operational transaction tables so standard non-AP/AR documents can bear tax.
ALTER TABLE operational_documents
  ADD COLUMN IF NOT EXISTS subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_total NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE operational_document_lines
  ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0);

CREATE INDEX IF NOT EXISTS idx_operational_document_lines_tax_code
  ON operational_document_lines(tax_code_id)
  WHERE tax_code_id IS NOT NULL;

-- Standard manual tax adjustments: used for audit/filer corrections and direct tax-only entries.
CREATE TABLE IF NOT EXISTS tax_adjustments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  adjustment_date DATE NOT NULL,
  tax_type TEXT NOT NULL CHECK (tax_type IN ('VAT','GST','SALES')),
  direction TEXT NOT NULL CHECK (direction IN ('output','input')),
  box_code TEXT,
  description TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount <> 0),
  account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  counter_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','voided')),
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  void_reason TEXT,
  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_adjustments_org_date_status
  ON tax_adjustments(organization_id, adjustment_date DESC, status);

INSERT INTO permissions (code, description) VALUES
  ('tax.adjustment.read', 'Read tax adjustments'),
  ('tax.adjustment.manage', 'Create and manage tax adjustments'),
  ('tax.adjustment.post', 'Post tax adjustments'),
  ('tax.adjustment.void', 'Void tax adjustments')
ON CONFLICT (code) DO NOTHING;

COMMIT;
