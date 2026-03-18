BEGIN;

CREATE TABLE IF NOT EXISTS warehouse_bins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, warehouse_id, code)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_bins_org_wh_status ON warehouse_bins(organization_id, warehouse_id, status);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  source_document_id UUID NULL REFERENCES operational_documents(id) ON DELETE SET NULL,
  reserved_for_type TEXT,
  reserved_for_id UUID,
  reference TEXT,
  notes TEXT,
  qty_reserved NUMERIC(18,6) NOT NULL CHECK (qty_reserved > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','cancelled','fulfilled')),
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  released_by UUID REFERENCES users(id) ON DELETE SET NULL,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_reservations_org_wh_item_status ON inventory_reservations(organization_id, warehouse_id, item_id, status);

CREATE TABLE IF NOT EXISTS inventory_transfer_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  request_date DATE NOT NULL,
  source_warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  dest_warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  reference TEXT,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','posted','cancelled')),
  rejection_reason TEXT,
  submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inventory_transaction_id UUID REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  CONSTRAINT inventory_transfer_requests_distinct_wh CHECK (source_warehouse_id <> dest_warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_transfer_requests_org_status ON inventory_transfer_requests(organization_id, status, request_date DESC);

CREATE TABLE IF NOT EXISTS inventory_transfer_request_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_request_id UUID NOT NULL REFERENCES inventory_transfer_requests(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_request_lines_req ON inventory_transfer_request_lines(transfer_request_id);

CREATE TABLE IF NOT EXISTS inventory_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  batch_no TEXT NOT NULL,
  manufacture_date DATE,
  expiry_date DATE,
  qty_on_hand NUMERIC(18,6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','depleted','expired','quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, warehouse_id, item_id, batch_no)
);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_org_wh_item ON inventory_batches(organization_id, warehouse_id, item_id, status);

CREATE TABLE IF NOT EXISTS inventory_serial_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES inventory_batches(id) ON DELETE SET NULL,
  serial_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','reserved','issued','transferred','scrapped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, item_id, serial_no)
);

CREATE INDEX IF NOT EXISTS idx_inventory_serials_org_wh_item_status ON inventory_serial_numbers(organization_id, warehouse_id, item_id, status);

CREATE TABLE IF NOT EXISTS inventory_traceability_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_line_id UUID NOT NULL REFERENCES inventory_transaction_lines(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES inventory_batches(id) ON DELETE SET NULL,
  serial_id UUID REFERENCES inventory_serial_numbers(id) ON DELETE SET NULL,
  quantity NUMERIC(18,6),
  direction TEXT NOT NULL CHECK (direction IN ('in','out','move')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_traceability_links_line ON inventory_traceability_links(transaction_line_id);

COMMIT;
