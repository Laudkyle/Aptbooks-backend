-- 005_tier3_invoices.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  customer_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,

  invoice_no TEXT NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,

  currency_code TEXT NOT NULL DEFAULT 'GHS',
  fx_rate NUMERIC(18,6) NOT NULL DEFAULT 1,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','issued','paid','voided')),

  memo TEXT,

  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
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

  UNIQUE (organization_id, invoice_no)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no INT NOT NULL,

  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),

  revenue_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (invoice_id, line_no)
);

-- simple sequence table for invoice numbers
CREATE TABLE IF NOT EXISTS invoice_sequences (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_no BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_org_status_date ON invoices(organization_id, status, invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(organization_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);
