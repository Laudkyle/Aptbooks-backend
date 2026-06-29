BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE SEQUENCE IF NOT EXISTS pos_sale_no_seq START 1;
CREATE SEQUENCE IF NOT EXISTS commerce_order_no_seq START 1;

-- POS uses existing inventory_items, warehouses and business_partners. These tables add only POS/commerce-specific state.
CREATE TABLE IF NOT EXISTS commerce_price_lists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  currency_code CHAR(3) NOT NULL DEFAULT 'GHS' REFERENCES currencies(code),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS commerce_price_list_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  price_list_id UUID NOT NULL REFERENCES commerce_price_lists(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  unit_price NUMERIC(18,6) NOT NULL CHECK (unit_price >= 0),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, price_list_id, item_id, effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS pos_stores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  address_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS pos_registers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES pos_stores(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  device_label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, store_id, code)
);

CREATE TABLE IF NOT EXISTS pos_shifts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES pos_stores(id) ON DELETE RESTRICT,
  register_id UUID NOT NULL REFERENCES pos_registers(id) ON DELETE RESTRICT,
  opened_by UUID REFERENCES users(id) ON DELETE SET NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  opening_cash_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  closing_cash_amount NUMERIC(18,2),
  expected_cash_amount NUMERIC(18,2),
  cash_variance_amount NUMERIC(18,2),
  closing_notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','voided')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_open_shift_per_register
  ON pos_shifts(organization_id, register_id) WHERE status='open';

CREATE TABLE IF NOT EXISTS pos_cash_movements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shift_id UUID NOT NULL REFERENCES pos_shifts(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('cash_in','cash_out','safe_drop','bank_deposit')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  reason TEXT,
  reference TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_accounting_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  default_cash_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  sales_revenue_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  discount_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  sales_returns_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  cogs_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  inventory_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  cash_over_short_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_default_accounting_profile
  ON pos_accounting_profiles(organization_id) WHERE is_default=true AND status='active';

CREATE TABLE IF NOT EXISTS pos_payment_method_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pos_accounting_profile_id UUID NOT NULL REFERENCES pos_accounting_profiles(id) ON DELETE CASCADE,
  payment_method_id UUID NOT NULL REFERENCES payment_methods(id) ON DELETE CASCADE,
  clearing_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  fee_expense_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, pos_accounting_profile_id, payment_method_id)
);

CREATE TABLE IF NOT EXISTS pos_sales (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sale_no TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'pos' CHECK (channel IN ('pos','ecommerce','manual','whatsapp','marketplace')),
  store_id UUID NOT NULL REFERENCES pos_stores(id) ON DELETE RESTRICT,
  register_id UUID NOT NULL REFERENCES pos_registers(id) ON DELETE RESTRICT,
  shift_id UUID NOT NULL REFERENCES pos_shifts(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  customer_id UUID REFERENCES business_partners(id) ON DELETE SET NULL,
  cashier_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
  subtotal_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  balance_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  cogs_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('draft','completed','voided','posted','partially_returned','returned','partially_refunded','refunded')),
  idempotency_key TEXT,
  inventory_transaction_id UUID REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  posted_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  source_order_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, sale_no),
  UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_pos_sales_org_date ON pos_sales(organization_id, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_pos_sales_org_status ON pos_sales(organization_id, status);

CREATE TABLE IF NOT EXISTS pos_sale_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sale_id UUID NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  description TEXT,
  quantity NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(18,6) NOT NULL CHECK (unit_price >= 0),
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  unit_cost NUMERIC(18,6) NOT NULL DEFAULT 0,
  cogs_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sale_id, line_no)
);

CREATE TABLE IF NOT EXISTS pos_sale_line_taxes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sale_id UUID NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  sale_line_id UUID NOT NULL REFERENCES pos_sale_lines(id) ON DELETE CASCADE,
  source_tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  tax_code TEXT,
  tax_name TEXT,
  rate NUMERIC(9,6) NOT NULL DEFAULT 0,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_type TEXT,
  box_code TEXT,
  reporting_group TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_sale_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sale_id UUID NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  shift_id UUID NOT NULL REFERENCES pos_shifts(id) ON DELETE RESTRICT,
  payment_method_id UUID NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  provider_reference TEXT,
  status TEXT NOT NULL DEFAULT 'captured' CHECK (status IN ('pending','captured','failed','refunded','voided')),
  captured_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_refunds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sale_id UUID NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','posted','voided')),
  refund_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_id UUID REFERENCES pos_stores(id) ON DELETE SET NULL,
  register_id UUID REFERENCES pos_registers(id) ON DELETE SET NULL,
  device_code TEXT NOT NULL,
  device_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','inactive')),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, device_code)
);

CREATE TABLE IF NOT EXISTS pos_sync_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id UUID REFERENCES pos_devices(id) ON DELETE SET NULL,
  batch_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','partial')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (organization_id, batch_no)
);

CREATE TABLE IF NOT EXISTS commerce_sales_channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL DEFAULT 'web' CHECK (channel_type IN ('web','pos','whatsapp','marketplace','manual')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS commerce_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL,
  channel_code TEXT NOT NULL DEFAULT 'web',
  customer_id UUID REFERENCES business_partners(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('cart','pending_payment','payment_failed','paid','processing','fulfilled','cancelled','partially_refunded','refunded','returned')),
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
  subtotal_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ,
  pos_sale_id UUID REFERENCES pos_sales(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, order_no)
);

CREATE TABLE IF NOT EXISTS commerce_order_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  description TEXT,
  quantity NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(18,6) NOT NULL CHECK (unit_price >= 0),
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  taxable_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_code_id UUID REFERENCES tax_codes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, line_no)
);

CREATE TABLE IF NOT EXISTS commerce_order_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  payment_method_id UUID REFERENCES payment_methods(id) ON DELETE SET NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  provider_reference TEXT,
  status TEXT NOT NULL DEFAULT 'captured' CHECK (status IN ('pending','captured','failed','refunded')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commerce_payment_providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL DEFAULT 'manual' CHECK (provider_type IN ('manual','paystack','flutterwave','hubtel','theteller','bank_terminal')),
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS commerce_payment_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES commerce_payment_providers(id) ON DELETE SET NULL,
  reference TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','refund')),
  amount NUMERIC(18,2) NOT NULL,
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','captured','failed','refunded','cancelled')),
  sale_id UUID REFERENCES pos_sales(id) ON DELETE SET NULL,
  order_id UUID REFERENCES commerce_orders(id) ON DELETE SET NULL,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, reference)
);

INSERT INTO commerce_sales_channels(organization_id, code, name, channel_type)
SELECT id, 'pos', 'In-store POS', 'pos' FROM organizations
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO commerce_sales_channels(organization_id, code, name, channel_type)
SELECT id, 'web', 'Online Store', 'web' FROM organizations
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO commerce_price_lists(organization_id, code, name, currency_code, is_default, status)
SELECT id, 'RETAIL', 'Retail Price List', base_currency_code, true, 'active' FROM organizations
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO pos_accounting_profiles(organization_id, name, is_default, status)
SELECT id, 'Default POS Accounting Profile', true, 'active' FROM organizations
ON CONFLICT (organization_id, name) DO NOTHING;

INSERT INTO permissions(code, description) VALUES
  ('commerce.catalog.read', 'Read commerce product catalog and price lists'),
  ('commerce.catalog.manage', 'Manage commerce price lists'),
  ('commerce.customers.read', 'Read commerce customer purchase information'),
  ('commerce.orders.read', 'Read e-commerce orders'),
  ('commerce.orders.manage', 'Create, pay and fulfill e-commerce orders'),
  ('pos.setup.read', 'Read POS stores and registers'),
  ('pos.setup.manage', 'Manage POS stores and registers'),
  ('pos.shift.open', 'Open POS shifts'),
  ('pos.shift.close', 'Close POS shifts'),
  ('pos.cash.manage', 'Manage POS cash movements'),
  ('pos.sale.create', 'Create POS sales'),
  ('pos.sale.read', 'Read POS sales and receipts'),
  ('pos.sale.post', 'Post POS sales to accounting'),
  ('pos.sale.void', 'Void POS sales'),
  ('pos.sale.refund', 'Refund POS sales'),
  ('pos.reports.view', 'View POS and commerce reports')
ON CONFLICT (code) DO NOTHING;

-- Give existing administrator roles access to the new module by default.
INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'commerce.catalog.read','commerce.catalog.manage','commerce.customers.read','commerce.orders.read','commerce.orders.manage',
  'pos.setup.read','pos.setup.manage','pos.shift.open','pos.shift.close','pos.cash.manage','pos.sale.create','pos.sale.read','pos.sale.post','pos.sale.void','pos.sale.refund','pos.reports.view'
)
WHERE lower(r.name) IN ('admin','administrator','super admin','owner')
ON CONFLICT DO NOTHING;

COMMIT;
