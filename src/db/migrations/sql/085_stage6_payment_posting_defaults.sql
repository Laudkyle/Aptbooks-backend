-- Stage 6: Defaults for posting online payment intents into ledgers

BEGIN;

ALTER TABLE IF EXISTS payment_settings
  ADD COLUMN IF NOT EXISTS online_cash_account_id UUID NULL REFERENCES chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS online_payment_method_id UUID NULL REFERENCES payment_methods(id);

COMMIT;
