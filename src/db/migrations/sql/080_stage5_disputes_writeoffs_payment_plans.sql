-- Stage 5: Disputes, Write-offs, Payment Plans

CREATE TABLE IF NOT EXISTS dispute_reason_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  code TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, code)
);

CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice','bill')),
  entity_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  reason_code_id UUID,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','void')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  notes TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disputes_org_status ON disputes(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_disputes_entity ON disputes(organization_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS dispute_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  dispute_id UUID NOT NULL,
  action_type TEXT NOT NULL,
  payload JSONB,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispute_actions_dispute ON dispute_actions(dispute_id);

CREATE TABLE IF NOT EXISTS writeoff_reason_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  code TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, code)
);

CREATE TABLE IF NOT EXISTS writeoff_settings (
  organization_id UUID PRIMARY KEY,
  ar_bad_debt_expense_account_id UUID,
  ap_writeoff_income_account_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS writeoffs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice','bill')),
  entity_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  reason_code_id UUID,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','posted','void')),
  workflow_document_id UUID,
  posted_journal_id UUID,
  notes TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_writeoffs_org_status ON writeoffs(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_writeoffs_entity ON writeoffs(organization_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS writeoff_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  writeoff_id UUID NOT NULL,
  action_type TEXT NOT NULL,
  payload JSONB,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_writeoff_actions_writeoff ON writeoff_actions(writeoff_id);

CREATE TABLE IF NOT EXISTS payment_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice','bill')),
  entity_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  total_amount NUMERIC(18,2) NOT NULL,
  start_date DATE NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly')),
  installment_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_plans_org_status ON payment_plans(organization_id, status);

CREATE TABLE IF NOT EXISTS payment_plan_installments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  payment_plan_id UUID NOT NULL,
  due_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','waived')),
  paid_at TIMESTAMPTZ,
  settlement_ref JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_plan_installments_plan ON payment_plan_installments(payment_plan_id);

-- Permissions
INSERT INTO permissions (code, description)
SELECT v.code, v.description
FROM (VALUES
  ('disputes.read','Read disputes and dispute codes'),
  ('disputes.manage','Create/update/resolve disputes'),
  ('writeoffs.read','Read write-offs'),
  ('writeoffs.manage','Create/update/submit/approve/post write-offs'),
  ('payment_plans.read','Read payment plans'),
  ('payment_plans.manage','Create/update/cancel payment plans')
) AS v(code,description)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = v.code);
