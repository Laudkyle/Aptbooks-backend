-- Adds missing workflow columns used by inventory stock count services.
-- This keeps repo code and DB schema in sync.

ALTER TABLE inventory_stock_counts
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_by UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS ix_inventory_stock_counts_submitted_at
  ON inventory_stock_counts(organization_id, submitted_at);
