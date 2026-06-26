-- Planning production hardening
-- Adds stricter lifecycle fields and constraints for allocation approval/post/reversal.

ALTER TABLE cost_allocations DROP CONSTRAINT IF EXISTS cost_allocations_status_check;
ALTER TABLE cost_allocations
  ADD CONSTRAINT cost_allocations_status_check
  CHECK (status IN ('computed','approved','rejected','posted','reversed','archived'));

ALTER TABLE cost_allocations
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS approved_by UUID NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS rejected_by UUID NULL,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS reversed_by UUID NULL,
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id UUID NULL;

DROP INDEX IF EXISTS ux_cost_allocations_org_rule_period_active;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cost_allocations_org_rule_period_current
  ON cost_allocations (organization_id, rule_id, period_id)
  WHERE status IN ('computed','approved','posted');

CREATE INDEX IF NOT EXISTS idx_cost_allocations_org_period_status
  ON cost_allocations(organization_id, period_id, status);

CREATE INDEX IF NOT EXISTS idx_cost_allocations_posted_journal
  ON cost_allocations(organization_id, posted_journal_entry_id)
  WHERE posted_journal_entry_id IS NOT NULL;
