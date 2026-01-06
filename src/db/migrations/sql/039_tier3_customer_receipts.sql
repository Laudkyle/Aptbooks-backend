-- 039_tier3_customer_receipts.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- CUSTOMER RECEIPTS (Accounts Receivable) - Tier 3
-- ============================================================
-- Mirrors vendor_payments design:
--  - Draft receipt with allocations
--  - Posting creates the GL journal: Dr Cash/Bank, Cr A/R
--  - Allocations drive invoice settlement state (paid vs issued)

CREATE TABLE IF NOT EXISTS customer_receipts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  customer_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,

  receipt_no TEXT NOT NULL,
  receipt_date DATE NOT NULL,

  currency_code TEXT NOT NULL DEFAULT 'GHS',
  fx_rate NUMERIC(18,6) NOT NULL DEFAULT 1,

  payment_method_id UUID REFERENCES payment_methods(id) ON DELETE SET NULL,

  -- GL account you debit (Cash/Bank)
  cash_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  amount_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount_total >= 0),

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','posted','voided')),

  memo TEXT,

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

  UNIQUE (organization_id, receipt_no)
);

CREATE TABLE IF NOT EXISTS customer_receipt_allocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_receipt_id UUID NOT NULL REFERENCES customer_receipts(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,

  amount_applied NUMERIC(18,2) NOT NULL CHECK (amount_applied > 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (customer_receipt_id, invoice_id)
);

-- Sequence table for receipt numbers
CREATE TABLE IF NOT EXISTS customer_receipt_sequences (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_no BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_receipts_org_status_date
  ON customer_receipts(organization_id, status, receipt_date);

CREATE INDEX IF NOT EXISTS idx_customer_receipts_customer
  ON customer_receipts(organization_id, customer_id);

CREATE INDEX IF NOT EXISTS idx_customer_receipt_allocs_receipt
  ON customer_receipt_allocations(customer_receipt_id);

CREATE INDEX IF NOT EXISTS idx_customer_receipt_allocs_invoice
  ON customer_receipt_allocations(invoice_id);
