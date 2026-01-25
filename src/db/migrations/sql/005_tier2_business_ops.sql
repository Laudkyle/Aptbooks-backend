-- 004_tier2_business_ops.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

-- Payment terms
CREATE TABLE IF NOT EXISTS payment_terms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  net_days INT NOT NULL DEFAULT 0 CHECK (net_days >= 0),
  discount_days INT CHECK (discount_days IS NULL OR discount_days >= 0),
  discount_rate NUMERIC(6,5) CHECK (discount_rate IS NULL OR (discount_rate >= 0 AND discount_rate <= 1)),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

-- Payment methods
CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, name)
);

-- Business partners
CREATE TABLE IF NOT EXISTS business_partners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  type TEXT NOT NULL CHECK (type IN ('customer','vendor')),
  name TEXT NOT NULL,
  code TEXT,
  email CITEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),

  default_receivable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  default_payable_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  payment_terms_id UUID REFERENCES payment_terms(id) ON DELETE SET NULL,

  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id, type, name),
  UNIQUE (organization_id, type, code)
);

CREATE INDEX IF NOT EXISTS idx_bp_org_type ON business_partners(organization_id, type);
CREATE INDEX IF NOT EXISTS idx_bp_org_status ON business_partners(organization_id, status);

-- Contacts
CREATE TABLE IF NOT EXISTS business_partner_contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  email CITEXT,
  phone TEXT,
  role TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bp_one_primary_contact
  ON business_partner_contacts(partner_id) WHERE is_primary = TRUE;

-- Addresses
CREATE TABLE IF NOT EXISTS business_partner_addresses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,

  label TEXT,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  country TEXT DEFAULT 'Ghana',
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bp_one_primary_address
  ON business_partner_addresses(partner_id) WHERE is_primary = TRUE;

-- Defaults (safe)
INSERT INTO payment_terms(organization_id, name, net_days, is_default, status)
SELECT o.id, 'Due on Receipt', 0, TRUE, 'active' FROM organizations o
ON CONFLICT (organization_id, name) DO NOTHING;

INSERT INTO payment_methods(organization_id, code, name, status)
SELECT o.id, 'CASH', 'Cash', 'active' FROM organizations o
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO payment_methods(organization_id, code, name, status)
SELECT o.id, 'BANK_TRANSFER', 'Bank Transfer', 'active' FROM organizations o
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO payment_methods(organization_id, code, name, status)
SELECT o.id, 'MOMO', 'Mobile Money', 'active' FROM organizations o
ON CONFLICT (organization_id, code) DO NOTHING;
