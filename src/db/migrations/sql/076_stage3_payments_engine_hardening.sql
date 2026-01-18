-- 076_stage3_payments_engine_hardening.sql
-- Stage 3: Payments engine hardening (unapplied cash, discounts, reallocation audit)

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- Payment settings per organization
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

  -- AR settings
  ar_unapplied_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  ar_discount_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  -- AP settings
  ap_prepayments_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  ap_discount_income_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO payment_settings(organization_id)
SELECT id FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

-- ------------------------------------------------------------
-- Extend receipts/payments with settlement breakdown
-- ------------------------------------------------------------
ALTER TABLE customer_receipts
  ADD COLUMN IF NOT EXISTS unapplied_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settlement_total NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE vendor_payments
  ADD COLUMN IF NOT EXISTS unapplied_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settlement_total NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE customer_receipt_allocations
  ADD COLUMN IF NOT EXISTS discount_taken NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount_taken >= 0);

ALTER TABLE vendor_payment_allocations
  ADD COLUMN IF NOT EXISTS discount_taken NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount_taken >= 0);

-- ------------------------------------------------------------
-- Allocation reallocation audit (append-only)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_receipt_allocation_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_receipt_id UUID NOT NULL REFERENCES customer_receipts(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cr_alloc_events_receipt
  ON customer_receipt_allocation_events(customer_receipt_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vendor_payment_allocation_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_payment_id UUID NOT NULL REFERENCES vendor_payments(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vp_alloc_events_payment
  ON vendor_payment_allocation_events(vendor_payment_id, created_at DESC);

-- ------------------------------------------------------------
-- Permissions
-- ------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('payment_config.manage', 'Manage payment settings and payment terms'),
  ('transactions.allocations.reallocate', 'Reallocate posted receipts/payments within controls')
ON CONFLICT (code) DO NOTHING;

COMMIT;
