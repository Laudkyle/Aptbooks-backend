
CREATE TABLE IF NOT EXISTS ledger_reconciliation_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('scan','export','auto_correct_preview','auto_correct_apply','rebuild')),
  status TEXT NOT NULL CHECK (status IN ('reconciled','issues','corrected','rebuilt','exported','preview')),
  accounts_compared INT NOT NULL DEFAULT 0,
  mismatch_count INT NOT NULL DEFAULT 0,
  total_variance NUMERIC(18,2) NOT NULL DEFAULT 0,
  threshold_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledg_recon_history_org_period_created
  ON ledger_reconciliation_history(organization_id, period_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledg_recon_history_org_action_created
  ON ledger_reconciliation_history(organization_id, action_type, created_at DESC);
