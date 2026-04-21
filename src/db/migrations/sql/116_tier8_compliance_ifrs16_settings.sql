-- 116_tier8_compliance_ifrs16_settings.sql
-- IFRS 16 settings/defaults for frontend settings tab and backend lease defaulting.

BEGIN;

CREATE TABLE IF NOT EXISTS ifrs16_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  default_term_months integer NULL CHECK (default_term_months IS NULL OR default_term_months > 0),
  default_payments_per_year integer NULL CHECK (default_payments_per_year IS NULL OR default_payments_per_year IN (1,2,4,12)),
  default_annual_discount_rate numeric(18,6) NULL CHECK (default_annual_discount_rate IS NULL OR default_annual_discount_rate >= 0),
  default_payment_timing text NOT NULL DEFAULT 'arrears' CHECK (default_payment_timing IN ('arrears','advance')),

  rou_asset_account_id uuid NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  lease_liability_account_id uuid NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  interest_expense_account_id uuid NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  depreciation_expense_account_id uuid NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  accumulated_depreciation_account_id uuid NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  cash_account_id uuid NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  default_notes_template text NULL,

  created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

COMMIT;
