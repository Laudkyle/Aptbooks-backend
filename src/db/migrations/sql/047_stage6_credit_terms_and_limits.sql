-- 047_stage6_credit_terms_and_limits.sql
-- Stage 6: Credit limits / credit policy for AR management reporting

BEGIN;

CREATE TABLE IF NOT EXISTS business_partner_credit_policies (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_partner_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,

  credit_limit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  credit_days INT NOT NULL DEFAULT 30 CHECK (credit_days >= 0),
  hold_if_over BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (organization_id, business_partner_id)
);

CREATE INDEX IF NOT EXISTS idx_bp_credit_policy_org
  ON business_partner_credit_policies(organization_id);

-- Ensure rows exist for all customers (defaults)
INSERT INTO business_partner_credit_policies(organization_id, business_partner_id)
SELECT bp.organization_id, bp.id
FROM business_partners bp
WHERE bp.type = 'customer'
ON CONFLICT (organization_id, business_partner_id) DO NOTHING;

COMMIT;
