BEGIN;

-- Compatibility fix for items module expecting reorder fields
ALTER TABLE IF EXISTS inventory_items
  ADD COLUMN IF NOT EXISTS reorder_point NUMERIC(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reorder_quantity NUMERIC(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reorder_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Optional safety checks
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_items_reorder_point_nonnegative_chk'
  ) THEN
    ALTER TABLE inventory_items
      ADD CONSTRAINT inventory_items_reorder_point_nonnegative_chk
      CHECK (reorder_point >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_items_reorder_quantity_nonnegative_chk'
  ) THEN
    ALTER TABLE inventory_items
      ADD CONSTRAINT inventory_items_reorder_quantity_nonnegative_chk
      CHECK (reorder_quantity >= 0);
  END IF;
END $$;

-- Helpful index if you query reorderable items often
CREATE INDEX IF NOT EXISTS idx_inventory_items_reorder_enabled
  ON inventory_items (organization_id, reorder_enabled);

COMMIT;