-- Tier 5: Inventory (Weighted Average default, FIFO optional)
-- NOTE: Value is maintained via transactional extended_cost + (optional) FIFO layers.
-- Quantity balances are tracked per (organization, warehouse, item).
BEGIN;

-- Items & master data
CREATE TABLE IF NOT EXISTS item_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, code)
);

CREATE TABLE IF NOT EXISTS item_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  -- accounting links
  inventory_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  cogs_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  adjustment_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  clearing_account_id uuid NOT NULL REFERENCES chart_of_accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, code)
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES item_categories(id),
  unit_id uuid NOT NULL REFERENCES item_units(id),
  sku text NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, sku)
);

CREATE TABLE IF NOT EXISTS warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, code)
);

-- Quantity + avg cost balances (Weighted Average)
CREATE TABLE IF NOT EXISTS inventory_balances (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  qty_on_hand numeric(18,6) NOT NULL DEFAULT 0,
  avg_unit_cost numeric(18,6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, warehouse_id, item_id)
);

-- Inventory transactions
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES accounting_periods(id),
  txn_date date NOT NULL,
  txn_type text NOT NULL CHECK (txn_type IN ('receipt','issue','transfer','adjustment')),
  source_warehouse_id uuid NULL REFERENCES warehouses(id),
  dest_warehouse_id uuid NULL REFERENCES warehouses(id),
  reference text NULL,
  memo text NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  journal_entry_id uuid NULL REFERENCES journal_entries(id),
  idempotency_key text NULL,
  created_by uuid NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS inventory_transaction_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES inventory_transactions(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  -- For receipts: supplied cost. For issues/transfers/negative adjustments: computed from balance/layers.
  unit_cost numeric(18,6) NULL,
  extended_cost numeric(18,6) NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- FIFO optional layers (only used if system setting inventoryCostMethod = FIFO)
CREATE TABLE IF NOT EXISTS inventory_cost_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  received_txn_line_id uuid NOT NULL REFERENCES inventory_transaction_lines(id) ON DELETE CASCADE,
  qty_remaining numeric(18,6) NOT NULL,
  unit_cost numeric(18,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_layer_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_line_id uuid NOT NULL REFERENCES inventory_transaction_lines(id) ON DELETE CASCADE,
  layer_id uuid NOT NULL REFERENCES inventory_cost_layers(id) ON DELETE CASCADE,
  quantity numeric(18,6) NOT NULL,
  unit_cost numeric(18,6) NOT NULL
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_inv_txn_org_date ON inventory_transactions(organization_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_inv_bal_org_item ON inventory_balances(organization_id, item_id);

COMMIT;
