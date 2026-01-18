-- Stage 4: Collections queue & dunning

CREATE TABLE IF NOT EXISTS dunning_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT,
  body TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dunning_templates_org ON dunning_templates(organization_id);

CREATE TABLE IF NOT EXISTS dunning_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  start_days_past_due INTEGER NOT NULL DEFAULT 1,
  cadence_days INTEGER NOT NULL DEFAULT 7,
  max_reminders INTEGER NOT NULL DEFAULT 6,
  severity TEXT NOT NULL DEFAULT 'soft',
  template_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dunning_rules_org ON dunning_rules(organization_id);

CREATE TABLE IF NOT EXISTS collections_cases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  case_type TEXT NOT NULL DEFAULT 'ar',
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to_user_id UUID,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  notes TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collections_cases_org_status ON collections_cases(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_collections_cases_org_partner ON collections_cases(organization_id, partner_id);

CREATE TABLE IF NOT EXISTS collections_case_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  case_id UUID NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'invoice',
  entity_id UUID NOT NULL,
  open_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collections_case_items_case ON collections_case_items(case_id);

CREATE TABLE IF NOT EXISTS collections_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  case_id UUID NOT NULL,
  action_type TEXT NOT NULL,
  action_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collections_actions_case ON collections_actions(case_id);

CREATE TABLE IF NOT EXISTS dunning_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  rule_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated',
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dunning_runs_org ON dunning_runs(organization_id);

CREATE TABLE IF NOT EXISTS dunning_run_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  run_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  days_past_due INTEGER NOT NULL,
  amount_due NUMERIC(18,2) NOT NULL,
  message_preview JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dunning_run_items_run ON dunning_run_items(run_id);
CREATE INDEX IF NOT EXISTS idx_dunning_run_items_org_status ON dunning_run_items(organization_id, status);

-- Permissions
INSERT INTO permissions (code, description)
SELECT v.code, v.description
FROM (VALUES
  ('collections.read','Read collections queue, cases, dunning'),
  ('collections.manage','Create/update cases, rules, templates, actions'),
  ('collections.dunning.run','Generate dunning runs')
) AS v(code,description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);
