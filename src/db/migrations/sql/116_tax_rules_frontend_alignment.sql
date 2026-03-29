BEGIN;

ALTER TABLE tax_rules
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS supply_type TEXT,
  ADD COLUMN IF NOT EXISTS place_of_supply_basis TEXT;

UPDATE tax_rules
   SET code = COALESCE(NULLIF(code, ''), regexp_replace(lower(name), '[^a-z0-9]+', '_', 'g'))
 WHERE code IS NULL OR code = '';

ALTER TABLE tax_rules DROP CONSTRAINT IF EXISTS tax_rules_supply_type_check;
ALTER TABLE tax_rules
  ADD CONSTRAINT tax_rules_supply_type_check
  CHECK (supply_type IS NULL OR supply_type IN ('goods','services','mixed','import','export'));

ALTER TABLE tax_rules DROP CONSTRAINT IF EXISTS tax_rules_place_of_supply_basis_check;
ALTER TABLE tax_rules
  ADD CONSTRAINT tax_rules_place_of_supply_basis_check
  CHECK (place_of_supply_basis IS NULL OR place_of_supply_basis IN ('customer_location','supplier_location','ship_to','service_performance'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_rules_org_code
  ON tax_rules(organization_id, code)
  WHERE code IS NOT NULL;

COMMIT;
