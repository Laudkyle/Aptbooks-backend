-- Run as the production runtime identity under an explicitly bound tenant:
--   SELECT set_config('app.current_organization_id','<organization uuid>',false);
-- This script is read-only and fails loudly when Phase 2 financial assurances
-- are absent or core ledger invariants are already broken.
DO $$
DECLARE
  missing_migration integer;
  unbalanced integer;
  projection_mismatches integer;
  missing_provenance integer;
BEGIN
  SELECT COUNT(*) INTO missing_migration FROM schema_migrations WHERE id='162_phase2_financial_assurance.sql';
  IF missing_migration <> 1 THEN RAISE EXCEPTION 'Phase 2 migration 162 is not applied'; END IF;

  SELECT COUNT(*) INTO unbalanced
  FROM (
    SELECT je.id
    FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
    WHERE je.organization_id=aptbooks_current_organization_id() AND je.status IN ('posted','voided')
    GROUP BY je.id
    HAVING SUM(CASE WHEN jel.debit>0 THEN jel.amount_base ELSE 0 END) <>
           SUM(CASE WHEN jel.credit>0 THEN jel.amount_base ELSE 0 END)
  ) q;
  IF unbalanced <> 0 THEN RAISE EXCEPTION 'Found % unbalanced posted journal(s)', unbalanced; END IF;

  SELECT COUNT(*) INTO projection_mismatches
  FROM (
    SELECT COALESCE(c.period_id,g.period_id) period_id, COALESCE(c.account_id,g.account_id) account_id
    FROM accounting_posted_ledger_totals c
    FULL JOIN general_ledger_balances g
      ON g.organization_id=c.organization_id AND g.period_id=c.period_id AND g.account_id=c.account_id
    WHERE COALESCE(c.organization_id,g.organization_id)=aptbooks_current_organization_id()
      AND (COALESCE(c.debit_total,0)<>COALESCE(g.debit_total,0) OR COALESCE(c.credit_total,0)<>COALESCE(g.credit_total,0))
  ) q;
  IF projection_mismatches <> 0 THEN RAISE EXCEPTION 'Found % GL projection mismatch(es)', projection_mismatches; END IF;

  SELECT COUNT(*) INTO missing_provenance
  FROM journal_entries je
  LEFT JOIN journal_posting_provenance p ON p.journal_entry_id=je.id
  WHERE je.organization_id=aptbooks_current_organization_id()
    AND je.status IN ('posted','voided')
    AND je.created_at >= (SELECT applied_at FROM schema_migrations WHERE id='162_phase2_financial_assurance.sql')
    AND p.id IS NULL;
  IF missing_provenance <> 0 THEN RAISE EXCEPTION 'Found % post-Phase-2 journal(s) without provenance', missing_provenance; END IF;
END $$;

SELECT 'phase2_financial_assurance_ok' AS status;
