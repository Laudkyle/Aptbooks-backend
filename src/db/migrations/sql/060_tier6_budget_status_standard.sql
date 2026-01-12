-- Make budgets support standard lifecycle statuses (draft/active/archived)
DO $$
DECLARE c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'budgets'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%';

  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE budgets DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE budgets
  ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE budgets
  ADD CONSTRAINT budgets_status_check CHECK (status IN ('draft','active','archived'));
