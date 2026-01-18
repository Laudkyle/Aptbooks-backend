-- 073_stage5_credit_debit_notes.sql
-- Stage 5: Credit/Debit Notes (AR/AP adjustments)

BEGIN;

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('transactions.credit_note.read', 'Read credit notes'),
  ('transactions.credit_note.manage', 'Create/update credit notes'),
  ('transactions.credit_note.issue', 'Issue credit notes'),
  ('transactions.credit_note.apply', 'Apply credit notes to invoices'),
  ('transactions.credit_note.void', 'Void credit notes'),

  ('transactions.debit_note.read', 'Read debit notes'),
  ('transactions.debit_note.manage', 'Create/update debit notes'),
  ('transactions.debit_note.issue', 'Issue debit notes'),
  ('transactions.debit_note.apply', 'Apply debit notes to bills'),
  ('transactions.debit_note.void', 'Void debit notes')
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Credit Notes (AR adjustments)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  customer_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,
  credit_note_no TEXT NOT NULL,
  credit_note_date DATE NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'GHS',
  fx_rate NUMERIC(18,6) NOT NULL DEFAULT 1,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','issued','voided')),

  memo TEXT,

  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,

  period_id UUID REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,

  issued_at TIMESTAMPTZ,
  issued_by UUID REFERENCES users(id) ON DELETE SET NULL,

  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id, credit_note_no)
);

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  credit_note_id UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  revenue_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE RESTRICT,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (credit_note_id, line_no)
);

CREATE TABLE IF NOT EXISTS credit_note_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  credit_note_id UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount_applied NUMERIC(18,2) NOT NULL CHECK (amount_applied > 0),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS credit_note_sequences (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_no BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_notes_org_status_date ON credit_notes(organization_id, status, credit_note_date);
CREATE INDEX IF NOT EXISTS idx_credit_notes_org_customer ON credit_notes(organization_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_lines_cn ON credit_note_lines(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_applications_invoice ON credit_note_applications(organization_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_applications_cn ON credit_note_applications(organization_id, credit_note_id);

-- -----------------------------------------------------------------------------
-- Debit Notes (AP adjustments)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS debit_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  vendor_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,
  debit_note_no TEXT NOT NULL,
  debit_note_date DATE NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'GHS',
  fx_rate NUMERIC(18,6) NOT NULL DEFAULT 1,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','issued','voided')),

  memo TEXT,

  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,

  period_id UUID REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,

  issued_at TIMESTAMPTZ,
  issued_by UUID REFERENCES users(id) ON DELETE SET NULL,

  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id, debit_note_no)
);

CREATE TABLE IF NOT EXISTS debit_note_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  debit_note_id UUID NOT NULL REFERENCES debit_notes(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  expense_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE RESTRICT,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (debit_note_id, line_no)
);

CREATE TABLE IF NOT EXISTS debit_note_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  debit_note_id UUID NOT NULL REFERENCES debit_notes(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  amount_applied NUMERIC(18,2) NOT NULL CHECK (amount_applied > 0),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS debit_note_sequences (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_no BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debit_notes_org_status_date ON debit_notes(organization_id, status, debit_note_date);
CREATE INDEX IF NOT EXISTS idx_debit_notes_org_vendor ON debit_notes(organization_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_debit_note_lines_dn ON debit_note_lines(debit_note_id);
CREATE INDEX IF NOT EXISTS idx_debit_note_applications_bill ON debit_note_applications(organization_id, bill_id);
CREATE INDEX IF NOT EXISTS idx_debit_note_applications_dn ON debit_note_applications(organization_id, debit_note_id);

COMMIT;
