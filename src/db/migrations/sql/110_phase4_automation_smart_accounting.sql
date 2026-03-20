BEGIN;

CREATE TABLE IF NOT EXISTS automation_recurring_transactions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text NULL,
  source_type text NOT NULL DEFAULT 'journal_payload' CHECK (source_type IN ('journal_payload','journal_id')),
  source_journal_id uuid NULL REFERENCES journal_entries(id) ON DELETE SET NULL,
  journal_payload jsonb NULL,
  schedule_type text NOT NULL CHECK (schedule_type IN ('daily','weekly','monthly','interval_days')),
  interval_days integer NULL,
  weekday integer NULL,
  day_of_month integer NULL,
  start_date date NOT NULL,
  end_date date NULL,
  next_run_date date NULL,
  last_run_at timestamptz NULL,
  auto_post boolean NOT NULL DEFAULT true,
  is_enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_automation_recurring_transactions_org_code UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_automation_recurring_transactions_due ON automation_recurring_transactions(organization_id, is_enabled, next_run_date);

CREATE TABLE IF NOT EXISTS automation_recurring_transaction_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recurring_transaction_id uuid NOT NULL REFERENCES automation_recurring_transactions(id) ON DELETE CASCADE,
  run_date date NOT NULL,
  status text NOT NULL,
  journal_entry_id uuid NULL REFERENCES journal_entries(id) ON DELETE SET NULL,
  message text NULL,
  payload_snapshot jsonb NULL,
  result_snapshot jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_recurring_runs_org_recurring ON automation_recurring_transaction_runs(organization_id, recurring_transaction_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automation_reconciliation_profiles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  min_confidence_score numeric(8,6) NOT NULL DEFAULT 0.75,
  lookback_days integer NOT NULL DEFAULT 30,
  max_suggestions_per_line integer NOT NULL DEFAULT 3,
  is_enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_reconciliation_profiles_org ON automation_reconciliation_profiles(organization_id, is_enabled, bank_account_id);

CREATE TABLE IF NOT EXISTS automation_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES automation_reconciliation_profiles(id) ON DELETE CASCADE,
  run_date date NOT NULL,
  status text NOT NULL,
  message text NULL,
  summary_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS automation_reconciliation_results (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES automation_reconciliation_runs(id) ON DELETE CASCADE,
  statement_line_id uuid NOT NULL REFERENCES bank_statement_lines(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  confidence_score numeric(8,6) NOT NULL,
  suggestion_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_reconciliation_results_run ON automation_reconciliation_results(organization_id, run_id, confidence_score DESC);

CREATE TABLE IF NOT EXISTS automation_document_match_profiles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_type text NOT NULL,
  target_type text NOT NULL,
  date_window_days integer NOT NULL DEFAULT 7,
  amount_tolerance numeric(18,6) NOT NULL DEFAULT 0,
  min_confidence_score numeric(8,6) NOT NULL DEFAULT 0.70,
  is_enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NULL,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_document_match_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES automation_document_match_profiles(id) ON DELETE CASCADE,
  run_date date NOT NULL,
  status text NOT NULL,
  summary_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS automation_document_match_results (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES automation_document_match_runs(id) ON DELETE CASCADE,
  source_entity_type text NOT NULL,
  source_entity_id uuid NOT NULL,
  target_entity_type text NOT NULL,
  target_entity_id uuid NOT NULL,
  confidence_score numeric(8,6) NOT NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_document_match_results_run ON automation_document_match_results(organization_id, run_id, confidence_score DESC);

CREATE TABLE IF NOT EXISTS automation_classification_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  target_kind text NOT NULL DEFAULT 'transaction',
  keyword_pattern text NULL,
  exclude_pattern text NULL,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_classification_rules_org ON automation_classification_rules(organization_id, is_active, priority);

CREATE TABLE IF NOT EXISTS automation_classification_logs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_text text NOT NULL,
  source_kind text NOT NULL DEFAULT 'transaction',
  matched_rule_id uuid NULL REFERENCES automation_classification_rules(id) ON DELETE SET NULL,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence_score numeric(8,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_classification_logs_org_created ON automation_classification_logs(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automation_notification_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  trigger_type text NOT NULL,
  target_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  severity text NOT NULL DEFAULT 'info',
  config_json jsonb NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_automation_notification_rules_org_code UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_automation_notification_rules_org ON automation_notification_rules(organization_id, is_enabled, trigger_type);

INSERT INTO permissions(code, description)
VALUES
  ('automation.recurring.read', 'Read recurring transaction automations'),
  ('automation.recurring.manage', 'Manage recurring transaction automations'),
  ('automation.recurring.run', 'Run recurring transaction automations'),
  ('automation.jobs.read', 'Read accounting job automation tasks'),
  ('automation.jobs.manage', 'Manage accounting job automation tasks'),
  ('automation.jobs.run', 'Run accounting job automation tasks'),
  ('automation.reconciliation.read', 'Read auto reconciliation profiles and results'),
  ('automation.reconciliation.manage', 'Manage auto reconciliation profiles'),
  ('automation.reconciliation.run', 'Run auto reconciliation profiles'),
  ('automation.document-matching.read', 'Read intelligent document matching'),
  ('automation.document-matching.manage', 'Manage intelligent document matching profiles'),
  ('automation.document-matching.run', 'Run intelligent document matching'),
  ('automation.classification.read', 'Read automation classification rules and logs'),
  ('automation.classification.manage', 'Manage automation classification rules'),
  ('automation.classification.run', 'Run automation classification'),
  ('automation.notifications.read', 'Read smart notification rules'),
  ('automation.notifications.manage', 'Manage smart notification rules'),
  ('automation.notifications.run', 'Run smart notification rules')
ON CONFLICT (code) DO NOTHING;

COMMIT;
