-- Phase 6 completion: inventory transaction draft/approve/post support
-- Add line direction for adjustments and helpful indexes for lifecycle queries.

ALTER TABLE inventory_transaction_lines
  ADD COLUMN IF NOT EXISTS direction TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_inventory_txn_lines_direction'
  ) THEN
    ALTER TABLE inventory_transaction_lines
      ADD CONSTRAINT chk_inventory_txn_lines_direction
      CHECK (direction IS NULL OR direction IN ('increase','decrease'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_txn_lines_txn_id ON inventory_transaction_lines(transaction_id);
CREATE INDEX IF NOT EXISTS idx_inventory_txn_lines_item_id ON inventory_transaction_lines(item_id);
