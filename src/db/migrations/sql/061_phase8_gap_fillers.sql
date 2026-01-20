-- 061_phase8_gap_fillers.sql
-- Phase 8: Fill remaining Banking + Workflow + Enterprise polish API gaps

BEGIN;

-- -----------------------------------------------------------------------------
-- Bank matching rules (simple configurable heuristics)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_matching_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  amount_tolerance NUMERIC(18,6) NOT NULL DEFAULT 0,
  date_window_days INT NOT NULL DEFAULT 3,
  description_similarity_min NUMERIC(5,4) NOT NULL DEFAULT 0.3000,
  priority INT NOT NULL DEFAULT 100,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_bank_matching_rules_org_active
  ON bank_matching_rules(organization_id, is_active, priority);

-- -----------------------------------------------------------------------------
-- Reconciliation lifecycle metadata
-- -----------------------------------------------------------------------------
ALTER TABLE bank_reconciliations
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS closed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS close_note TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_org_account_period
  ON bank_reconciliations(organization_id, bank_account_id, period_id);

-- -----------------------------------------------------------------------------
-- Client-side log ingestion storage
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NULL REFERENCES organizations(id) ON DELETE SET NULL,
  user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  correlation_id TEXT NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error','fatal')),
  message TEXT NOT NULL,
  context JSONB NULL,
  user_agent TEXT NULL,
  ip INET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_logs_corr_id ON client_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_client_logs_org_created ON client_logs(organization_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Permissions for newly exposed endpoints
-- -----------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('banking.cashbook.read', 'Read cashbook and bank transaction views'),
  ('banking.matching.suggest', 'Request bank matching suggestions'),
  ('banking.matching.rules.manage', 'Manage bank matching rules'),
  ('banking.reconciliations.read', 'Read bank reconciliations and diffs'),
  ('approvals.inbox.read', 'Read approval inbox/queue'),
  ('utilities.client_logs.write', 'Ingest client-side logs'),
  ('utilities.client_logs.read', 'Read client-side logs'),
  ('utilities.i18n.read', 'Read internationalization scaffolding'),
  ('utilities.a11y.read', 'Read accessibility compliance status'),
  ('utilities.release.read', 'Read release/environment info'),
  ('utilities.tests.run', 'Execute test suites via API'),
  ('reporting.imports.manage', 'Bulk import budgets/forecasts/kpis')
ON CONFLICT (code) DO NOTHING;

COMMIT;
