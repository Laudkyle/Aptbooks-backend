-- Production hardening follow-up.
-- 1) Keep the registration/reference currency set consistent on existing databases.
-- 2) Re-apply the fail-closed RLS discovery pass so tenant-owned tables created
--    after migration 161 receive the same protection as earlier tables.

INSERT INTO currencies(code, name)
VALUES
  ('GHS','Ghana Cedi'),
  ('USD','US Dollar'),
  ('EUR','Euro'),
  ('GBP','British Pound')
ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name;

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.table_name,
           (c.is_nullable = 'YES') AS organization_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema=c.table_schema
       AND t.table_name=c.table_name
       AND t.table_type='BASE TABLE'
     WHERE c.table_schema='public'
       AND c.column_name='organization_id'
       AND c.udt_name='uuid'
       AND c.table_name <> ALL (ARRAY[
         'organizations',
         'users',
         'user_organizations',
         'api_keys',
         'refresh_tokens',
         'password_reset_tokens',
         'email_two_factor_challenges',
         'login_history',
         'error_logs',
         'rate_limit_windows',
         'schema_migrations',
         'scheduled_tasks',
         'scheduled_task_runs',
         'scheduled_task_lock'
       ])
     ORDER BY c.table_name
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rec.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', rec.table_name);
    EXECUTE format('DROP POLICY IF EXISTS aptbooks_tenant_isolation ON public.%I', rec.table_name);
    EXECUTE format('DROP POLICY IF EXISTS aptbooks_tenant_select ON public.%I', rec.table_name);
    EXECUTE format('DROP POLICY IF EXISTS aptbooks_tenant_insert ON public.%I', rec.table_name);
    EXECUTE format('DROP POLICY IF EXISTS aptbooks_tenant_update ON public.%I', rec.table_name);
    EXECUTE format('DROP POLICY IF EXISTS aptbooks_tenant_delete ON public.%I', rec.table_name);

    -- Nullable organization rows can represent system-provided read-only
    -- defaults. They may be read by every tenant, but tenant runtime code may
    -- neither create a global row nor "claim" one by updating NULL to its tenant.
    IF rec.organization_nullable THEN
      EXECUTE format(
        'CREATE POLICY aptbooks_tenant_select ON public.%I FOR SELECT '
        'USING (organization_id IS NULL OR organization_id = aptbooks_current_organization_id())',
        rec.table_name
      );
      EXECUTE format(
        'CREATE POLICY aptbooks_tenant_insert ON public.%I FOR INSERT '
        'WITH CHECK (organization_id = aptbooks_current_organization_id())',
        rec.table_name
      );
      EXECUTE format(
        'CREATE POLICY aptbooks_tenant_update ON public.%I FOR UPDATE '
        'USING (organization_id = aptbooks_current_organization_id()) '
        'WITH CHECK (organization_id = aptbooks_current_organization_id())',
        rec.table_name
      );
      EXECUTE format(
        'CREATE POLICY aptbooks_tenant_delete ON public.%I FOR DELETE '
        'USING (organization_id = aptbooks_current_organization_id())',
        rec.table_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY aptbooks_tenant_isolation ON public.%I '
        'USING (organization_id = aptbooks_current_organization_id()) '
        'WITH CHECK (organization_id = aptbooks_current_organization_id())',
        rec.table_name
      );
    END IF;
  END LOOP;
END $$;

-- Protect detail/bridge tables that inherit ownership through one or more
-- foreign keys to already protected parents. Multiple parent links are combined
-- with AND, so a child cannot bridge records from two different organizations.
-- Nullable FKs are allowed only when every FK column is NULL; partial-null
-- composite keys do not become an RLS bypass.
DO $$
DECLARE
  child_rec record;
  fk_rec record;
  join_predicate text;
  null_predicate text;
  policy_expression text;
  write_policy_expression text;
  linked_parent_expression text;
  protected_fk_count integer;
  changed integer;
BEGIN
  LOOP
    changed := 0;

    FOR child_rec IN
      SELECT c.oid AS child_oid, n.nspname AS schema_name, c.relname AS child_table
        FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public'
         AND c.relkind IN ('r','p')
         AND NOT c.relrowsecurity
         AND NOT EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
         )
         AND c.relname <> ALL (ARRAY[
           'organizations','users','user_organizations','api_keys','refresh_tokens',
           'password_reset_tokens','email_two_factor_challenges','login_history',
           'error_logs','rate_limit_windows','schema_migrations','scheduled_tasks',
           'scheduled_task_runs','scheduled_task_lock'
         ])
       ORDER BY c.relname
    LOOP
      policy_expression := NULL;
      write_policy_expression := NULL;
      linked_parent_expression := NULL;
      protected_fk_count := 0;

      FOR fk_rec IN
        SELECT fk.oid AS fk_oid, parent.relname AS parent_table
          FROM pg_constraint fk
          JOIN pg_class parent ON parent.oid=fk.confrelid
         WHERE fk.conrelid=child_rec.child_oid
           AND fk.contype='f'
           AND parent.relrowsecurity
         ORDER BY fk.oid
      LOOP
        SELECT string_agg(
                 format('p.%I = %I.%I', pa.attname, child_rec.child_table, ca.attname),
                 ' AND ' ORDER BY ck.ordinality
               ),
               string_agg(
                 format('%I.%I IS NULL', child_rec.child_table, ca.attname),
                 ' AND ' ORDER BY ck.ordinality
               )
          INTO join_predicate, null_predicate
          FROM pg_constraint fk
          JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY ck(attnum, ordinality) ON true
          JOIN LATERAL unnest(fk.confkey) WITH ORDINALITY pk(attnum, ordinality) ON pk.ordinality=ck.ordinality
          JOIN pg_attribute ca ON ca.attrelid=fk.conrelid AND ca.attnum=ck.attnum
          JOIN pg_attribute pa ON pa.attrelid=fk.confrelid AND pa.attnum=pk.attnum
         WHERE fk.oid=fk_rec.fk_oid;

        IF join_predicate IS NULL OR join_predicate = '' THEN
          CONTINUE;
        END IF;

        protected_fk_count := protected_fk_count + 1;
        policy_expression := concat_ws(
          ' AND ',
          policy_expression,
          format('((%s) OR EXISTS (SELECT 1 FROM public.%I p WHERE %s))',
                 null_predicate, fk_rec.parent_table, join_predicate)
        );
        write_policy_expression := concat_ws(
          ' AND ',
          write_policy_expression,
          format('((%s) OR EXISTS (SELECT 1 FROM public.%I p WHERE %s))',
                 null_predicate, fk_rec.parent_table, join_predicate)
        );
        linked_parent_expression := concat_ws(
          ' OR ',
          linked_parent_expression,
          format('EXISTS (SELECT 1 FROM public.%I p WHERE %s)', fk_rec.parent_table, join_predicate)
        );
      END LOOP;

      IF protected_fk_count = 0 OR policy_expression IS NULL THEN
        CONTINUE;
      END IF;

      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', child_rec.child_table);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', child_rec.child_table);
      EXECUTE format('DROP POLICY IF EXISTS aptbooks_parent_tenant_isolation ON public.%I', child_rec.child_table);
      EXECUTE format('DROP POLICY IF EXISTS aptbooks_parent_tenant_select ON public.%I', child_rec.child_table);
      EXECUTE format('DROP POLICY IF EXISTS aptbooks_parent_tenant_insert ON public.%I', child_rec.child_table);
      EXECUTE format('DROP POLICY IF EXISTS aptbooks_parent_tenant_update ON public.%I', child_rec.child_table);
      EXECUTE format('DROP POLICY IF EXISTS aptbooks_parent_tenant_delete ON public.%I', child_rec.child_table);
      -- Read-only global/default child rows (all protected parent FKs NULL)
      -- remain visible, but runtime writes must link to at least one protected
      -- parent and every non-null protected parent must resolve inside the same
      -- tenant. Existing global rows cannot be claimed by an UPDATE.
      write_policy_expression := format('(%s) AND (%s)', write_policy_expression, linked_parent_expression);
      EXECUTE format(
        'CREATE POLICY aptbooks_parent_tenant_select ON public.%I FOR SELECT USING (%s)',
        child_rec.child_table,
        policy_expression
      );
      EXECUTE format(
        'CREATE POLICY aptbooks_parent_tenant_insert ON public.%I FOR INSERT WITH CHECK (%s)',
        child_rec.child_table,
        write_policy_expression
      );
      EXECUTE format(
        'CREATE POLICY aptbooks_parent_tenant_update ON public.%I FOR UPDATE USING (%s) WITH CHECK (%s)',
        child_rec.child_table,
        write_policy_expression,
        write_policy_expression
      );
      EXECUTE format(
        'CREATE POLICY aptbooks_parent_tenant_delete ON public.%I FOR DELETE USING (%s)',
        child_rec.child_table,
        write_policy_expression
      );
      changed := changed + 1;
    END LOOP;

    EXIT WHEN changed = 0;
  END LOOP;
END $$;


