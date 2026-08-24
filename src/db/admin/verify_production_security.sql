-- Read-only production database security gate. Run as the runtime application role.
DO $$
DECLARE
  r record;
  missing_direct integer;
BEGIN
  SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
    INTO r FROM pg_roles WHERE rolname=current_user;
  IF r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'runtime database role is over-privileged: %', current_user;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind IN ('r','p') AND pg_get_userbyid(c.relowner)=current_user
  ) THEN
    RAISE EXCEPTION 'runtime role must not own application tables: %', current_user;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE id='161_phase1_row_level_tenant_isolation.sql'
  ) THEN
    RAISE EXCEPTION 'Phase 1 RLS migration 161 has not been applied';
  END IF;

  SELECT count(*) INTO missing_direct
    FROM information_schema.columns col
    JOIN pg_class c ON c.relname=col.table_name
    JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=col.table_schema
   WHERE col.table_schema='public'
     AND col.column_name='organization_id'
     AND col.udt_name='uuid'
     AND col.table_name <> ALL (ARRAY[
       'organizations','users','user_organizations','api_keys','refresh_tokens',
       'password_reset_tokens','email_two_factor_challenges','login_history',
       'error_logs','rate_limit_windows','schema_migrations','scheduled_tasks',
       'scheduled_task_runs','scheduled_task_lock'
     ])
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF missing_direct > 0 THEN
    RAISE EXCEPTION '% tenant-owned tables are missing ENABLE/FORCE RLS', missing_direct;
  END IF;
END $$;

SELECT 'aptbooks production database security gate: PASS' AS result;
