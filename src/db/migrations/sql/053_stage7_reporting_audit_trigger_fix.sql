BEGIN;

-- 1) Make entity_id nullable (some audited tables don't have NEW.id)
ALTER TABLE reporting_definition_audit
  ALTER COLUMN entity_id DROP NOT NULL;

-- 2) Optional but recommended: store a key snapshot for composite/no-id tables
ALTER TABLE reporting_definition_audit
  ADD COLUMN IF NOT EXISTS entity_key jsonb;

-- 3) Replace trigger function to avoid referencing NEW.id directly
CREATE OR REPLACE FUNCTION trg_audit_reporting_definition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid;
  v_entity_type text;
  v_entity_id uuid;
  v_row jsonb;
BEGIN
  v_entity_type := TG_TABLE_NAME;

  IF (TG_OP = 'DELETE') THEN
    v_org := OLD.organization_id;
    v_row := to_jsonb(OLD);
  ELSE
    v_org := NEW.organization_id;
    v_row := to_jsonb(NEW);
  END IF;

  -- Safely try to read an "id" field if it exists; otherwise keep NULL.
  v_entity_id := NULL;
  BEGIN
    IF (v_row ? 'id') AND (v_row->>'id') IS NOT NULL AND (v_row->>'id') <> '' THEN
      v_entity_id := (v_row->>'id')::uuid;
    END IF;
  EXCEPTION WHEN others THEN
    v_entity_id := NULL;
  END;

  IF (TG_OP = 'INSERT') THEN
    INSERT INTO reporting_definition_audit(
      organization_id, entity_type, entity_id, action, new_row, entity_key
    )
    VALUES (
      v_org, v_entity_type, v_entity_id, 'INSERT', to_jsonb(NEW), v_row
    );
    RETURN NEW;

  ELSIF (TG_OP = 'UPDATE') THEN
    INSERT INTO reporting_definition_audit(
      organization_id, entity_type, entity_id, action, old_row, new_row, entity_key
    )
    VALUES (
      v_org, v_entity_type, v_entity_id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), v_row
    );
    RETURN NEW;

  ELSE -- DELETE
    INSERT INTO reporting_definition_audit(
      organization_id, entity_type, entity_id, action, old_row, entity_key
    )
    VALUES (
      v_org, v_entity_type, v_entity_id, 'DELETE', to_jsonb(OLD), v_row
    );
    RETURN OLD;
  END IF;
END;
$$;

COMMIT;
