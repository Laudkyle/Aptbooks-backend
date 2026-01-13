-- Tier 6: Allocation run lines (persisted splits)

CREATE TABLE IF NOT EXISTS cost_allocation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  allocation_id UUID NOT NULL REFERENCES cost_allocations(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES allocation_rules(id) ON DELETE RESTRICT,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL,
  to_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  amount NUMERIC(18,2) NOT NULL,
  weight NUMERIC(18,6) NOT NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cost_allocation_lines_alloc_line
  ON cost_allocation_lines(allocation_id, line_no);

CREATE INDEX IF NOT EXISTS ix_cost_allocation_lines_org_period
  ON cost_allocation_lines(organization_id, period_id);
