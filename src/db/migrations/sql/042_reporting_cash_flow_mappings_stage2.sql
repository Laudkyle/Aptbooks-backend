-- Reporting Stage 2: Cash Flow (IAS 7) mapping layer (Direct method)
--
-- Creates cash flow categories and mappings to classify cash/bank movements.

BEGIN;

CREATE TABLE IF NOT EXISTS cash_flow_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Section: operating / investing / financing
  section TEXT NOT NULL CHECK (section IN ('operating','investing','financing')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, section, code)
);

CREATE INDEX IF NOT EXISTS idx_cash_flow_categories_org
  ON cash_flow_categories(organization_id, section, sort_order);

-- Map non-cash accounts to cash flow categories.
CREATE TABLE IF NOT EXISTS cash_flow_account_mappings (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  category_id UUID NOT NULL REFERENCES cash_flow_categories(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_cash_flow_mappings_category
  ON cash_flow_account_mappings(category_id);

-- Cash accounts to include in cash flow (cash on hand + bank accounts).
CREATE TABLE IF NOT EXISTS cash_flow_cash_accounts (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','bank_accounts','heuristic')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, account_id)
);

-- Seed: for existing organizations, initialise an unclassified category in each section
-- and register bank_accounts.gl_account_id as cash accounts.
INSERT INTO cash_flow_categories (organization_id, section, code, name, sort_order)
SELECT o.id, s.section, 'UNCLASSIFIED', 'Unclassified cash flows', 999
FROM organizations o
CROSS JOIN (VALUES ('operating'::text),('investing'::text),('financing'::text)) s(section)
WHERE NOT EXISTS (
  SELECT 1 FROM cash_flow_categories c
  WHERE c.organization_id=o.id AND c.code='UNCLASSIFIED'
);

INSERT INTO cash_flow_cash_accounts (organization_id, account_id, source)
SELECT b.organization_id, b.gl_account_id, 'bank_accounts'
FROM bank_accounts b
ON CONFLICT DO NOTHING;

COMMIT;
