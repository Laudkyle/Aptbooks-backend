-- 048_stage6_inventory_reorder_settings.sql
-- Stage 6: Reorder point / safety stock settings for inventory reporting

BEGIN;

CREATE TABLE IF NOT EXISTS inventory_reorder_settings (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,

  reorder_point NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  reorder_quantity NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (reorder_quantity >= 0),
  safety_stock NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  lead_time_days INT NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (organization_id, warehouse_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_inv_reorder_org_wh
  ON inventory_reorder_settings(organization_id, warehouse_id);

COMMIT;
