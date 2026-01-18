-- 086_phase6_assets_inventory_complete.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================
-- ASSETS
-- =============================

-- Minimal master data so assets can be transferred/reclassified by location/department.
CREATE TABLE IF NOT EXISTS org_locations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_org_locations_org_status ON org_locations(organization_id, status);

CREATE TABLE IF NOT EXISTS org_departments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_org_departments_org_status ON org_departments(organization_id, status);

-- Extend fixed_assets with tracking dimensions and valuation fields
ALTER TABLE fixed_assets
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES org_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES org_departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cost_center_id UUID REFERENCES cost_centers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS current_value NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS impairment_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (impairment_total >= 0),
  ADD COLUMN IF NOT EXISTS last_revaluation_at TIMESTAMPTZ;

UPDATE fixed_assets SET current_value = cost WHERE current_value IS NULL;

-- Event log for asset lifecycle actions
CREATE TABLE IF NOT EXISTS asset_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'transfer','reclass','revaluation','impairment','partial_disposal','maintenance','attachment'
  )),
  event_date DATE NOT NULL,
  reference TEXT,
  memo TEXT,
  payload_json JSONB,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asset_events_org_asset_date ON asset_events(organization_id, asset_id, event_date);

-- Links to document library
CREATE TABLE IF NOT EXISTS asset_document_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_asset_doc_links_org_asset ON asset_document_links(organization_id, asset_id);

-- =============================
-- INVENTORY
-- =============================

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  ADD COLUMN IF NOT EXISTS barcode TEXT;

CREATE INDEX IF NOT EXISTS idx_inventory_items_org_status ON inventory_items(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_org_barcode ON inventory_items(organization_id, barcode);

-- Variants
CREATE TABLE IF NOT EXISTS inventory_item_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  variant_code TEXT NOT NULL,
  attributes_json JSONB,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, variant_code)
);

CREATE INDEX IF NOT EXISTS idx_item_variants_org_item ON inventory_item_variants(organization_id, item_id);

-- Suppliers (partners)
CREATE TABLE IF NOT EXISTS inventory_item_suppliers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,
  lead_time_days INT,
  is_preferred BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, partner_id)
);

CREATE INDEX IF NOT EXISTS idx_item_suppliers_org_item ON inventory_item_suppliers(organization_id, item_id);

-- Item documents
CREATE TABLE IF NOT EXISTS inventory_item_document_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_item_doc_links_org_item ON inventory_item_document_links(organization_id, item_id);

-- Stock counts
CREATE TABLE IF NOT EXISTS inventory_stock_counts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  count_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','posted','voided')),
  reference TEXT,
  memo TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  posted_txn_id UUID REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_counts_org_status ON inventory_stock_counts(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_counts_org_wh_date ON inventory_stock_counts(organization_id, warehouse_id, count_date);

CREATE TABLE IF NOT EXISTS inventory_stock_count_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  stock_count_id UUID NOT NULL REFERENCES inventory_stock_counts(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  system_qty NUMERIC(18,6) NOT NULL DEFAULT 0,
  counted_qty NUMERIC(18,6) NOT NULL DEFAULT 0,
  variance_qty NUMERIC(18,6) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(18,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stock_count_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_count_lines_sc_item ON inventory_stock_count_lines(stock_count_id, item_id);

-- Inventory transaction lifecycle enhancements (keep existing status column, add status2 for transition without breaking old code)
ALTER TABLE inventory_transactions
  ADD COLUMN IF NOT EXISTS status2 TEXT,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_txn_id UUID REFERENCES inventory_transactions(id) ON DELETE SET NULL;

UPDATE inventory_transactions SET status2 = status WHERE status2 IS NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_tx_org_status2 ON inventory_transactions(organization_id, status2);
