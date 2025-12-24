-- 007_tier3_bills_vendor_payments.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- BILLS (Accounts Payable) - Tier 3
-- ============================================================

CREATE TABLE IF NOT EXISTS bills (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  vendor_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,

  bill_no TEXT NOT NULL,
  bill_date DATE NOT NULL,
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

  CHECK (due_date >= bill_date),
  UNIQUE (organization_id, bill_no)
);

CREATE TABLE IF NOT EXISTS bill_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  line_no INT NOT NULL,

  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),

  expense_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (bill_id, line_no)
);

-- Simple sequence table for bill numbers
CREATE TABLE IF NOT EXISTS bill_sequences (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_no BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bills_org_status_date
  ON bills(organization_id, status, bill_date);

CREATE INDEX IF NOT EXISTS idx_bills_vendor
  ON bills(organization_id, vendor_id);

CREATE INDEX IF NOT EXISTS idx_bill_lines_bill
  ON bill_lines(bill_id);

-- ============================================================
-- VENDOR PAYMENTS (Partial allocations allowed) - Tier 3
-- ============================================================

CREATE TABLE IF NOT EXISTS vendor_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  vendor_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,

  payment_no TEXT NOT NULL,
  payment_date DATE NOT NULL,

  currency_code TEXT NOT NULL DEFAULT 'GHS',
  fx_rate NUMERIC(18,6) NOT NULL DEFAULT 1,

  payment_method_id UUID REFERENCES payment_methods(id) ON DELETE SET NULL,

  -- For Phase 2b: this is the GL account you credit (Cash/Bank).
  cash_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  amount_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount_total >= 0),

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','posted','voided')),

  period_id UUID REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,

  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,

  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id, payment_no)
);

CREATE TABLE IF NOT EXISTS vendor_payment_allocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_payment_id UUID NOT NULL REFERENCES vendor_payments(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,

  amount_applied NUMERIC(18,2) NOT NULL CHECK (amount_applied > 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (vendor_payment_id, bill_id)
);

-- Sequence table for vendor payment numbers
CREATE TABLE IF NOT EXISTS vendor_payment_sequences (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_no BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_payments_org_status_date
  ON vendor_payments(organization_id, status, payment_date);

CREATE INDEX IF NOT EXISTS idx_vendor_payments_vendor
  ON vendor_payments(organization_id, vendor_id);

CREATE INDEX IF NOT EXISTS idx_vendor_payment_allocs_payment
  ON vendor_payment_allocations(vendor_payment_id);

CREATE INDEX IF NOT EXISTS idx_vendor_payment_allocs_bill
  ON vendor_payment_allocations(bill_id);
