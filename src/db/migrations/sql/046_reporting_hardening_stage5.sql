-- 046_reporting_hardening_stage5.sql
-- Stage 5: Reporting hardening (audit + denormalized GL activity view)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- REPORTING DEFINITION AUDIT LOG
-- ============================================================

CREATE TABLE IF NOT EXISTS reporting_definition_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  old_row JSONB,
  new_row JSONB
);

CREATE INDEX IF NOT EXISTS idx_reporting_def_audit_org_time
  ON reporting_definition_audit(organization_id, changed_at DESC);

-- Generic helper function to audit changes.
CREATE OR REPLACE FUNCTION trg_audit_reporting_definition() RETURNS trigger AS $$
DECLARE
  v_org UUID;
  v_entity_type TEXT;
BEGIN
  -- Determine organization_id
  IF TG_TABLE_NAME = 'statement_templates' THEN
    v_org := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_type := 'statement_template';
  ELSIF TG_TABLE_NAME = 'statement_lines' THEN
    SELECT organization_id INTO v_org FROM statement_templates WHERE id = COALESCE(NEW.template_id, OLD.template_id);
    v_entity_type := 'statement_line';
  ELSIF TG_TABLE_NAME = 'statement_line_accounts' THEN
    SELECT st.organization_id INTO v_org
    FROM statement_lines sl
    JOIN statement_templates st ON st.id = sl.template_id
    WHERE sl.id = COALESCE(NEW.line_id, OLD.line_id);
    v_entity_type := 'statement_line_account';
  ELSIF TG_TABLE_NAME = 'cash_flow_account_mappings' THEN
    v_org := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_type := 'cash_flow_mapping';
  ELSIF TG_TABLE_NAME = 'reporting_equity_mappings' THEN
    v_org := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_type := 'equity_mapping';
  ELSE
    v_org := NULL;
    v_entity_type := TG_TABLE_NAME;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO reporting_definition_audit(organization_id, entity_type, entity_id, action, new_row)
    VALUES (v_org, v_entity_type, NEW.id, 'INSERT', to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO reporting_definition_audit(organization_id, entity_type, entity_id, action, old_row, new_row)
    VALUES (v_org, v_entity_type, NEW.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  ELSE
    INSERT INTO reporting_definition_audit(organization_id, entity_type, entity_id, action, old_row)
    VALUES (v_org, v_entity_type, OLD.id, 'DELETE', to_jsonb(OLD));
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_statement_templates') THEN
    CREATE TRIGGER audit_statement_templates
      AFTER INSERT OR UPDATE OR DELETE ON statement_templates
      FOR EACH ROW EXECUTE FUNCTION trg_audit_reporting_definition();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_statement_lines') THEN
    CREATE TRIGGER audit_statement_lines
      AFTER INSERT OR UPDATE OR DELETE ON statement_lines
      FOR EACH ROW EXECUTE FUNCTION trg_audit_reporting_definition();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_statement_line_accounts') THEN
    CREATE TRIGGER audit_statement_line_accounts
      AFTER INSERT OR UPDATE OR DELETE ON statement_line_accounts
      FOR EACH ROW EXECUTE FUNCTION trg_audit_reporting_definition();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_cash_flow_account_mappings') THEN
    CREATE TRIGGER audit_cash_flow_account_mappings
      AFTER INSERT OR UPDATE OR DELETE ON cash_flow_account_mappings
      FOR EACH ROW EXECUTE FUNCTION trg_audit_reporting_definition();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_reporting_equity_mappings') THEN
    CREATE TRIGGER audit_reporting_equity_mappings
      AFTER INSERT OR UPDATE OR DELETE ON reporting_equity_mappings
      FOR EACH ROW EXECUTE FUNCTION trg_audit_reporting_definition();
  END IF;
END $$;

-- ============================================================
-- DENORMALIZED GL ACTIVITY VIEW FOR EXPORTS / LEDGER DRILLDOWN
-- ============================================================

CREATE OR REPLACE VIEW reporting_gl_activity AS
SELECT
  je.organization_id,
  je.id AS journal_entry_id,
  je.entry_no,
  je.entry_date,
  je.memo AS journal_memo,
  je.status,
  jet.code AS journal_type_code,
  jet.name AS journal_type_name,
  je.period_id,
  jel.id AS journal_entry_line_id,
  jel.line_no,
  jel.account_id,
  coa.code AS account_code,
  coa.name AS account_name,
  at.code AS account_type_code,
  at.normal_balance,
  jel.description AS line_description,
  jel.debit,
  jel.credit,
  jel.currency_code,
  jel.fx_rate,
  jel.amount_base,
  je.created_at,
  je.updated_at
FROM journal_entries je
JOIN journal_entry_types jet ON jet.id = je.journal_entry_type_id
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN chart_of_accounts coa ON coa.id = jel.account_id
JOIN account_types at ON at.id = coa.account_type_id;
