DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id='163_phase4_operational_reliability.sql') THEN
    RAISE EXCEPTION 'Phase 4 operational reliability migration is missing after restore';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Forced row-level security baseline is missing after restore';
  END IF;
END $$;

-- Post-restore accounting integrity smoke test.
-- Intended to run with a privileged restore-verification identity because it
-- enumerates organizations, then deliberately binds tenant context before
-- touching tenant-protected accounting tables.
DO $$
DECLARE
  org record;
  bad_journals bigint;
BEGIN
  FOR org IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.current_organization_id', org.id::text, true);

    SELECT count(*) INTO bad_journals
      FROM (
        SELECT je.id
          FROM journal_entries je
          JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
         WHERE je.organization_id=org.id
           AND je.status='posted'
         GROUP BY je.id
        HAVING round(COALESCE(sum(jel.debit),0)::numeric, 2)
             <> round(COALESCE(sum(jel.credit),0)::numeric, 2)
      ) unbalanced;

    IF bad_journals > 0 THEN
      RAISE EXCEPTION 'organization % has % unbalanced posted journal(s)', org.id, bad_journals;
    END IF;
  END LOOP;
END $$;

SELECT 'post-restore posted-journal integrity: PASS' AS result;
