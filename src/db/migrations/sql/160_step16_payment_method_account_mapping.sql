-- Step 16: payment-method account mapping.
-- Payment methods may nominate a default posting account. Transaction users can
-- still override the account on an individual receipt/payment.

ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS default_account_id UUID NULL REFERENCES chart_of_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_methods_org_default_account
  ON payment_methods(organization_id, default_account_id)
  WHERE default_account_id IS NOT NULL;

-- Drop any mapping that could not belong to the same organization. This is
-- defensive for databases where the column may have been introduced manually.
UPDATE payment_methods pm
SET default_account_id = NULL
WHERE default_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM chart_of_accounts coa
    WHERE coa.id = pm.default_account_id
      AND coa.organization_id = pm.organization_id
  );

-- Safe backfill for the standard AptBooks onboarding chart only. We intentionally
-- do not guess a Mobile Money account; organizations should map MOMO to their
-- actual wallet/clearing GL account in Business > Payment Settings.
UPDATE payment_methods pm
SET default_account_id = coa.id
FROM chart_of_accounts coa
WHERE coa.organization_id = pm.organization_id
  AND coa.status = 'active'
  AND coa.is_postable = TRUE
  AND (
    (UPPER(pm.code) = 'CASH' AND coa.code = '1000')
    OR (UPPER(pm.code) IN ('BANK','BANK_TRANSFER','CHEQUE') AND coa.code = '1010')
  )
  AND pm.default_account_id IS NULL;
