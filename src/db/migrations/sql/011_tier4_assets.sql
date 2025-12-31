-- 010_tier4_assets.sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Asset categories
CREATE TABLE IF NOT EXISTS asset_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  code TEXT NOT NULL,
  name TEXT NOT NULL,

  -- COA links (postable, active validation is done in service layer)
  asset_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  accum_depr_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  depr_expense_account_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id, code),
  UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_asset_categories_org_status
  ON asset_categories(organization_id, status);

-- Fixed assets
CREATE TABLE IF NOT EXISTS fixed_assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  category_id UUID NOT NULL REFERENCES asset_categories(id) ON DELETE RESTRICT,

  code TEXT NOT NULL,
  name TEXT NOT NULL,

  acquisition_date DATE NOT NULL,
  cost NUMERIC(18,2) NOT NULL CHECK (cost >= 0),
  salvage_value NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft','active','retired','disposed')),

  retired_at TIMESTAMPTZ,
  disposed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS idx_fixed_assets_org_status
  ON fixed_assets(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_fixed_assets_org_category
  ON fixed_assets(organization_id, category_id);

-- Depreciation schedules (v1: straight-line monthly)
CREATE TABLE IF NOT EXISTS asset_depreciation_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  asset_id UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,

  method TEXT NOT NULL DEFAULT 'straight_line' CHECK (method IN ('straight_line')),
  useful_life_months INT NOT NULL CHECK (useful_life_months > 0),

  depreciation_start_date DATE NOT NULL,

  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','complete')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (asset_id)  -- one active schedule per asset in v1 (enforced in service too)
);

CREATE INDEX IF NOT EXISTS idx_depr_sched_org_status
  ON asset_depreciation_schedules(organization_id, status);

-- Depreciation transactions (posted outcomes)
CREATE TABLE IF NOT EXISTS asset_depreciation_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  asset_id UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
  schedule_id UUID NOT NULL REFERENCES asset_depreciation_schedules(id) ON DELETE RESTRICT,

  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,

  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_depr_tx_org_period
  ON asset_depreciation_transactions(organization_id, period_id);

CREATE INDEX IF NOT EXISTS idx_depr_tx_asset
  ON asset_depreciation_transactions(organization_id, asset_id, period_id);
