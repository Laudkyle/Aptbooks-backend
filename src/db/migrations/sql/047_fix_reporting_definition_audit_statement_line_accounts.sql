-- 047_fix_reporting_definition_audit_statement_line_accounts.sql
-- Fix reporting definition audit trigger so statement_line_accounts derives
-- organization_id via line_id (not the non-existent statement_line_id).

BEGIN;

CREATE OR REPLACE FUNCTION trg_audit_reporting_definition()
RETURNS TRIGGER AS $$
DECLARE
  v_org uuid;
  v_entity_type text;
  v_entity_id uuid;
  v_row jsonb;
BEGIN
  v_entity_type := TG_TABLE_NAME;

  IF (TG_OP = 'DELETE') THEN
    v_row := to_jsonb(OLD);

    BEGIN
      v_org := OLD.organization_id;
    EXCEPTION WHEN undefined_column THEN
      IF TG_TABLE_NAME = 'statement_line_accounts' THEN
        BEGIN
          SELECT sl.organization_id INTO v_org
          FROM statement_lines sl
          WHERE sl.id = OLD.line_id;
        EXCEPTION WHEN others THEN
          v_org := NULL;
        END;
      ELSE
        v_org := NULL;
      END IF;
    END;

  ELSE
    v_row := to_jsonb(NEW);

    BEGIN
      v_org := NEW.organization_id;
    EXCEPTION WHEN undefined_column THEN
      IF TG_TABLE_NAME = 'statement_line_accounts' THEN
        BEGIN
          SELECT sl.organization_id INTO v_org
          FROM statement_lines sl
          WHERE sl.id = NEW.line_id;
        EXCEPTION WHEN others THEN
          v_org := NULL;
        END;
      ELSE
        v_org := NULL;
      END IF;
    END;
  END IF;

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
      organization_id, entity_type, entity_id, action, new_row
    )
    VALUES (
      v_org, v_entity_type, v_entity_id, 'INSERT', to_jsonb(NEW)
    );
    RETURN NEW;

  ELSIF (TG_OP = 'UPDATE') THEN
    INSERT INTO reporting_definition_audit(
      organization_id, entity_type, entity_id, action, old_row, new_row
    )
    VALUES (
      v_org, v_entity_type, v_entity_id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW)
    );
    RETURN NEW;

  ELSE
    INSERT INTO reporting_definition_audit(
      organization_id, entity_type, entity_id, action, old_row
    )
    VALUES (
      v_org, v_entity_type, v_entity_id, 'DELETE', to_jsonb(OLD)
    );
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_statement_line_accounts ON statement_line_accounts;

CREATE TRIGGER audit_statement_line_accounts
  AFTER INSERT OR UPDATE OR DELETE ON statement_line_accounts
  FOR EACH ROW
  EXECUTE FUNCTION trg_audit_reporting_definition();

COMMIT;