BEGIN;

-- ============================================================
-- 1) CHART OF ACCOUNTS COMPATIBILITY COLUMNS
-- ============================================================

ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS subtype TEXT;

-- Backfill "type" from account_types.code
UPDATE chart_of_accounts coa
SET type = at.code
FROM account_types at
WHERE coa.account_type_id = at.id
  AND (coa.type IS NULL OR coa.type = '');

-- Backfill "subtype" from account_categories.name
UPDATE chart_of_accounts coa
SET subtype = ac.name
FROM account_categories ac
WHERE coa.category_id = ac.id
  AND (coa.subtype IS NULL OR coa.subtype = '');

-- Fallback subtype
UPDATE chart_of_accounts
SET subtype = 'general'
WHERE subtype IS NULL OR subtype = '';

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_org_type
  ON chart_of_accounts(organization_id, type);

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_org_subtype
  ON chart_of_accounts(organization_id, subtype);

-- ============================================================
-- 2) TAX CODES COMPATIBILITY COLUMN
-- ============================================================

ALTER TABLE tax_codes
  ADD COLUMN IF NOT EXISTS direction TEXT;

UPDATE tax_codes
SET direction = CASE
  WHEN tax_type = 'WITHHOLDING' THEN 'withholding'
  WHEN COALESCE(tax_scope, '') = 'reverse_charge' OR COALESCE(reverse_charge, FALSE) = TRUE THEN 'reverse_charge'
  WHEN application_scope = 'sales' THEN 'output'
  WHEN application_scope = 'purchases' THEN 'input'
  WHEN application_scope = 'both' THEN 'both'
  ELSE 'both'
END
WHERE direction IS NULL OR direction = '';

ALTER TABLE tax_codes
  DROP CONSTRAINT IF EXISTS tax_codes_direction_check;

ALTER TABLE tax_codes
  ADD CONSTRAINT tax_codes_direction_check
  CHECK (direction IN ('input', 'output', 'both', 'withholding', 'reverse_charge'));

CREATE INDEX IF NOT EXISTS idx_tax_codes_org_direction
  ON tax_codes(organization_id, direction);

-- ============================================================
-- 3) SYNC TRIGGER FOR chart_of_accounts
-- ============================================================

CREATE OR REPLACE FUNCTION sync_chart_of_accounts_compat_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.account_type_id IS NOT NULL THEN
    SELECT code
    INTO NEW.type
    FROM account_types
    WHERE id = NEW.account_type_id;
  END IF;

  IF NEW.category_id IS NOT NULL THEN
    SELECT name
    INTO NEW.subtype
    FROM account_categories
    WHERE id = NEW.category_id;
  END IF;

  NEW.subtype := COALESCE(NEW.subtype, 'general');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_chart_of_accounts_compat_columns ON chart_of_accounts;

CREATE TRIGGER trg_sync_chart_of_accounts_compat_columns
BEFORE INSERT OR UPDATE OF account_type_id, category_id
ON chart_of_accounts
FOR EACH ROW
EXECUTE FUNCTION sync_chart_of_accounts_compat_columns();

-- ============================================================
-- 4) SYNC TRIGGER FOR tax_codes.direction
-- ============================================================

CREATE OR REPLACE FUNCTION sync_tax_codes_direction()
RETURNS TRIGGER AS $$
BEGIN
  NEW.direction := CASE
    WHEN NEW.tax_type = 'WITHHOLDING' THEN 'withholding'
    WHEN COALESCE(NEW.tax_scope, '') = 'reverse_charge' OR COALESCE(NEW.reverse_charge, FALSE) = TRUE THEN 'reverse_charge'
    WHEN NEW.application_scope = 'sales' THEN 'output'
    WHEN NEW.application_scope = 'purchases' THEN 'input'
    WHEN NEW.application_scope = 'both' THEN 'both'
    ELSE COALESCE(NEW.direction, 'both')
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_tax_codes_direction ON tax_codes;

CREATE TRIGGER trg_sync_tax_codes_direction
BEFORE INSERT OR UPDATE OF tax_type, tax_scope, reverse_charge, application_scope
ON tax_codes
FOR EACH ROW
EXECUTE FUNCTION sync_tax_codes_direction();

-- ============================================================
-- 5) FINAL BACKFILL AGAIN AFTER TRIGGERS EXIST
-- ============================================================

UPDATE chart_of_accounts coa
SET type = at.code
FROM account_types at
WHERE coa.account_type_id = at.id;

UPDATE chart_of_accounts coa
SET subtype = ac.name
FROM account_categories ac
WHERE coa.category_id = ac.id;

UPDATE chart_of_accounts
SET subtype = 'general'
WHERE subtype IS NULL OR subtype = '';

UPDATE tax_codes
SET direction = CASE
  WHEN tax_type = 'WITHHOLDING' THEN 'withholding'
  WHEN COALESCE(tax_scope, '') = 'reverse_charge' OR COALESCE(reverse_charge, FALSE) = TRUE THEN 'reverse_charge'
  WHEN application_scope = 'sales' THEN 'output'
  WHEN application_scope = 'purchases' THEN 'input'
  WHEN application_scope = 'both' THEN 'both'
  ELSE 'both'
END;

COMMIT;