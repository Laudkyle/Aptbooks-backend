BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Returns / exchanges
CREATE TABLE IF NOT EXISTS pos_return_authorizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sale_id UUID NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  return_no TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','received','voided')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, return_no)
);

CREATE TABLE IF NOT EXISTS pos_return_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  return_id UUID NOT NULL REFERENCES pos_return_authorizations(id) ON DELETE CASCADE,
  sale_line_id UUID REFERENCES pos_sale_lines(id) ON DELETE SET NULL,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  refund_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  restock_action TEXT NOT NULL DEFAULT 'restock' CHECK (restock_action IN ('restock','damaged','discard','no_restock')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Promotions and coupons
CREATE TABLE IF NOT EXISTS commerce_promotions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  promotion_type TEXT NOT NULL CHECK (promotion_type IN ('percentage','fixed_amount','customer_group','bundle','manual')),
  discount_value NUMERIC(18,6) NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  min_spend_amount NUMERIC(18,2),
  max_discount_amount NUMERIC(18,2),
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS commerce_coupons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  promotion_id UUID REFERENCES commerce_promotions(id) ON DELETE SET NULL,
  usage_limit INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','expired','archived')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

-- Loyalty and store credit against existing business_partners customers
CREATE TABLE IF NOT EXISTS commerce_loyalty_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,
  points_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, customer_id)
);

CREATE TABLE IF NOT EXISTS commerce_loyalty_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  loyalty_account_id UUID NOT NULL REFERENCES commerce_loyalty_accounts(id) ON DELETE CASCADE,
  sale_id UUID REFERENCES pos_sales(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('earn','redeem','adjustment','expiry')),
  points NUMERIC(18,2) NOT NULL,
  note TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce_store_credit_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,
  balance_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency_code CHAR(3) NOT NULL DEFAULT 'GHS' REFERENCES currencies(code),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, customer_id)
);

CREATE TABLE IF NOT EXISTS commerce_store_credit_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_credit_account_id UUID NOT NULL REFERENCES commerce_store_credit_accounts(id) ON DELETE CASCADE,
  sale_id UUID REFERENCES pos_sales(id) ON DELETE SET NULL,
  refund_id UUID REFERENCES pos_refunds(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('issue','redeem','adjustment','refund')),
  amount NUMERIC(18,2) NOT NULL,
  note TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cash counts/deposits
CREATE TABLE IF NOT EXISTS pos_cash_counts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shift_id UUID NOT NULL REFERENCES pos_shifts(id) ON DELETE CASCADE,
  counted_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  expected_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  variance_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  counted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_cash_deposits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shift_id UUID REFERENCES pos_shifts(id) ON DELETE SET NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','deposited','reconciled','voided')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook events and receipt sequences
CREATE TABLE IF NOT EXISTS commerce_payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_event_id TEXT,
  event_type TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_valid BOOLEAN,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received','processed','failed','ignored')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, provider_event_id)
);

CREATE SEQUENCE IF NOT EXISTS pos_return_no_seq START 1;
CREATE SEQUENCE IF NOT EXISTS pos_receipt_no_seq START 1;

INSERT INTO permissions(code, description) VALUES
  ('commerce.promotions.manage','Manage commerce promotions and coupons'),
  ('commerce.loyalty.manage','Manage customer loyalty and store credit'),
  ('pos.return.manage','Manage POS returns'),
  ('pos.refund.manage','Manage POS refunds')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('commerce.promotions.manage','commerce.loyalty.manage','pos.return.manage','pos.refund.manage')
WHERE lower(r.name) IN ('admin','administrator','super admin','owner')
ON CONFLICT DO NOTHING;

COMMIT;
