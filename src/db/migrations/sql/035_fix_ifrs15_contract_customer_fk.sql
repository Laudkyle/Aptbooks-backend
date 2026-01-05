BEGIN;

-- Fix IFRS 15 contracts: reference business_partners instead of a non-existent customers table.
-- Migration 030 created ifrs15_contracts.customer_id REFERENCES customers(id), but the core model uses business_partners.

ALTER TABLE IF EXISTS ifrs15_contracts
  ADD COLUMN IF NOT EXISTS business_partner_id UUID;

-- Backfill from legacy column if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ifrs15_contracts' AND column_name = 'customer_id'
  ) THEN
    EXECUTE 'UPDATE ifrs15_contracts SET business_partner_id = customer_id WHERE business_partner_id IS NULL';
  END IF;
END $$;

-- Drop legacy FK/column if it exists.
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT tc.constraint_name INTO fk_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.table_name = 'ifrs15_contracts'
    AND tc.constraint_type = 'FOREIGN KEY'
    AND kcu.column_name = 'customer_id'
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE ifrs15_contracts DROP CONSTRAINT %I', fk_name);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ifrs15_contracts' AND column_name = 'customer_id'
  ) THEN
    EXECUTE 'ALTER TABLE ifrs15_contracts DROP COLUMN customer_id';
  END IF;
END $$;

-- Add correct FK.
ALTER TABLE IF EXISTS ifrs15_contracts
  ADD CONSTRAINT fk_ifrs15_contracts_business_partner
  FOREIGN KEY (business_partner_id) REFERENCES business_partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ifrs15_contracts_bp
  ON ifrs15_contracts(business_partner_id);

COMMIT;
