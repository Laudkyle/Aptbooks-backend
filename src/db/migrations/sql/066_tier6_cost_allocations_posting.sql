-- Adds posting metadata and idempotency safeguards for cost allocations

-- Add new columns if they don't exist
ALTER TABLE cost_allocations
ADD COLUMN IF NOT EXISTS posted_journal_entry_id UUID NULL,
ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS posted_by UUID NULL;

-- Create unique index if it doesn't exist
CREATE UNIQUE INDEX IF NOT EXISTS ux_cost_allocations_org_rule_period_active
ON cost_allocations (organization_id, rule_id, period_id)
WHERE status IN ('computed','posted');