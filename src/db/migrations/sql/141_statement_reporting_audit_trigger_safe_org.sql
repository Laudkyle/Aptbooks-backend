-- 141_statement_reporting_audit_trigger_safe_org.sql
-- Makes the reporting-definition audit trigger safe for audited tables that do not
-- carry organization_id directly, especially statement_line_accounts.

BEGIN;

ALTER TABLE reporting_definition_audit
  ALTER COLUMN entity_id DROP NOT NULL;

ALTER TABLE reporting_definition_audit
  ADD COLUMN IF NOT EXISTS entity_key jsonb;

CREATE OR REPLACE FUNCTION trg_audit_reporting_definition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid;
  v_entity_type text;
  v_entity_id uuid;
  v_row jsonb;
  v_line_id uuid;
BEGIN
  v_entity_type := TG_TABLE_NAME;

  IF TG_OP = 'DELETE' THEN
    v_row := to_jsonb(OLD);
  ELSE
    v_row := to_jsonb(NEW);
  END IF;

  v_org := NULL;

  -- Use organization_id directly only when the row actually has that key.
  IF (v_row ? 'organization_id') AND NULLIF(v_row->>'organization_id', '') IS NOT NULL THEN
    BEGIN
      v_org := (v_row->>'organization_id')::uuid;
    EXCEPTION WHEN others THEN
      v_org := NULL;
    END;
  END IF;

  -- statement_line_accounts has no organization_id in some schemas. Resolve it
  -- from statement_lines using either line_id or statement_line_id.
  IF v_org IS NULL AND TG_TABLE_NAME = 'statement_line_accounts' THEN
    BEGIN
      v_line_id := COALESCE(NULLIF(v_row->>'line_id', '')::uuid, NULLIF(v_row->>'statement_line_id', '')::uuid);
    EXCEPTION WHEN others THEN
      v_line_id := NULL;
    END;

    IF v_line_id IS NOT NULL THEN
      SELECT sl.organization_id
        INTO v_org
        FROM statement_lines sl
       WHERE sl.id = v_line_id
       LIMIT 1;
    END IF;
  END IF;

  -- Other mapping/audit tables can derive organization through template_id.
  IF v_org IS NULL AND (v_row ? 'template_id') AND NULLIF(v_row->>'template_id', '') IS NOT NULL THEN
    BEGIN
      SELECT st.organization_id
        INTO v_org
        FROM statement_templates st
       WHERE st.id = (v_row->>'template_id')::uuid
       LIMIT 1;
    EXCEPTION WHEN others THEN
      v_org := NULL;
    END;
  END IF;

  v_entity_id := NULL;
  IF (v_row ? 'id') AND NULLIF(v_row->>'id', '') IS NOT NULL THEN
    BEGIN
      v_entity_id := (v_row->>'id')::uuid;
    EXCEPTION WHEN others THEN
      v_entity_id := NULL;
    END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO reporting_definition_audit(
      organization_id, entity_type, entity_id, action, new_row, entity_key
    ) VALUES (
      v_org, v_entity_type, v_entity_id, 'INSERT', to_jsonb(NEW), v_row
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO reporting_definition_audit(
      organization_id, entity_type, entity_id, action, old_row, new_row, entity_key
    ) VALUES (
      v_org, v_entity_type, v_entity_id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), v_row
    );
    RETURN NEW;
  ELSE
    INSERT INTO reporting_definition_audit(
      organization_id, entity_type, entity_id, action, old_row, entity_key
    ) VALUES (
      v_org, v_entity_type, v_entity_id, 'DELETE', to_jsonb(OLD), v_row
    );
    RETURN OLD;
  END IF;
END;
$$;

-- Ensure the trigger exists on statement_line_accounts and uses the safe function.
DO $$
BEGIN
  IF to_regclass('public.statement_line_accounts') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS audit_statement_line_accounts ON statement_line_accounts;
    CREATE TRIGGER audit_statement_line_accounts
      AFTER INSERT OR UPDATE OR DELETE ON statement_line_accounts
      FOR EACH ROW EXECUTE FUNCTION trg_audit_reporting_definition();
  END IF;
END $$;

COMMIT;
