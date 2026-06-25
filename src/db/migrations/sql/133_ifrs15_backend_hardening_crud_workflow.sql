BEGIN;

-- IFRS 15 backend hardening: keep Stage 2 settings columns present, expand safe workflow statuses,
-- and support voided correction states used by the compliance API.

ALTER TABLE ifrs15_settings
  ADD COLUMN IF NOT EXISTS financing_interest_income_account_id UUID REFERENCES chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS financing_interest_expense_account_id UUID REFERENCES chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS default_cost_asset_account_id UUID REFERENCES chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS default_cost_amort_expense_account_id UUID REFERENCES chart_of_accounts(id);

ALTER TABLE ifrs15_contract_modifications
  DROP CONSTRAINT IF EXISTS ifrs15_contract_modifications_status_check;

ALTER TABLE ifrs15_contract_modifications
  ADD CONSTRAINT ifrs15_contract_modifications_status_check
    CHECK (status IN ('draft','submitted','approved','rejected','applied','voided'));

ALTER TABLE ifrs15_variable_consideration
  DROP CONSTRAINT IF EXISTS ifrs15_var_cons_status_ck;

ALTER TABLE ifrs15_variable_consideration
  ADD CONSTRAINT ifrs15_var_cons_status_ck
    CHECK (status IN ('DRAFT','REVIEWED','APPROVED','VOIDED'));

ALTER TABLE ifrs15_variable_consideration
  DROP CONSTRAINT IF EXISTS ifrs15_var_cons_include_requires_approved_ck;

ALTER TABLE ifrs15_variable_consideration
  ADD CONSTRAINT ifrs15_var_cons_include_requires_approved_ck
    CHECK (NOT include_in_transaction_price OR status='APPROVED');

ALTER TABLE ifrs15_variable_consideration
  DROP CONSTRAINT IF EXISTS ifrs15_var_cons_include_requires_highly_probable_ck;

ALTER TABLE ifrs15_variable_consideration
  ADD CONSTRAINT ifrs15_var_cons_include_requires_highly_probable_ck
    CHECK (NOT include_in_transaction_price OR highly_probable_no_reversal);

CREATE INDEX IF NOT EXISTS idx_ifrs15_mods_contract_status
  ON ifrs15_contract_modifications(contract_id, status, modification_date DESC);

CREATE INDEX IF NOT EXISTS idx_ifrs15_costs_contract_status
  ON ifrs15_capitalised_costs(contract_id, status, created_at DESC);

COMMIT;
