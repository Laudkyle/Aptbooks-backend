BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Add included amount field on contracts (used in effective transaction price)
ALTER TABLE ifrs15_contracts
  ADD COLUMN IF NOT EXISTS variable_consideration_included_amount NUMERIC(18,6) NOT NULL DEFAULT 0;

-- Governance fields for variable consideration entries
ALTER TABLE ifrs15_variable_consideration
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS highly_probable_no_reversal BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS constraint_basis TEXT,
  ADD COLUMN IF NOT EXISTS include_in_transaction_price BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS included_amount NUMERIC(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- Normalise legacy rows created before governance (if any)
UPDATE ifrs15_variable_consideration
SET
  status = CASE WHEN COALESCE(included, FALSE) THEN 'APPROVED' ELSE 'REVIEWED' END,
  include_in_transaction_price = COALESCE(included, FALSE),
  included_amount = CASE WHEN COALESCE(included, FALSE) THEN estimate_amount ELSE 0 END,
  highly_probable_no_reversal = CASE WHEN COALESCE(included, FALSE) THEN TRUE ELSE highly_probable_no_reversal END,
  reviewed_at = COALESCE(reviewed_at, created_at),
  approved_at = CASE WHEN COALESCE(included, FALSE) THEN COALESCE(approved_at, created_at) ELSE approved_at END
WHERE status IS NULL OR status NOT IN ('DRAFT','REVIEWED','APPROVED');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='ifrs15_var_cons_status_ck'
  ) THEN
    ALTER TABLE ifrs15_variable_consideration
      ADD CONSTRAINT ifrs15_var_cons_status_ck CHECK (status IN ('DRAFT','REVIEWED','APPROVED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='ifrs15_var_cons_include_requires_approved_ck'
  ) THEN
    ALTER TABLE ifrs15_variable_consideration
      ADD CONSTRAINT ifrs15_var_cons_include_requires_approved_ck
      CHECK (NOT include_in_transaction_price OR status='APPROVED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='ifrs15_var_cons_include_requires_highly_probable_ck'
  ) THEN
    ALTER TABLE ifrs15_variable_consideration
      ADD CONSTRAINT ifrs15_var_cons_include_requires_highly_probable_ck
      CHECK (NOT include_in_transaction_price OR highly_probable_no_reversal);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ifrs15_var_cons_contract_status_date
  ON ifrs15_variable_consideration(contract_id, status, effective_date DESC, created_at DESC);

COMMIT;
