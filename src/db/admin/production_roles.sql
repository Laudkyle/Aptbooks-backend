-- AptBooks production database role template.
--
-- Run this as a database owner/administrator AFTER the application schema has
-- been migrated. The example role names are intentionally fixed so this file is
-- auditable; rename them to your cloud/IAM roles if required and apply the same
-- grants. Passwords are deliberately not embedded here.
--
-- Runtime invariant: aptbooks_runtime must NEVER own application tables and must
-- remain NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aptbooks_migrator') THEN
    CREATE ROLE aptbooks_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aptbooks_runtime') THEN
    CREATE ROLE aptbooks_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aptbooks_readonly') THEN
    CREATE ROLE aptbooks_readonly LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

ALTER ROLE aptbooks_migrator NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE aptbooks_runtime  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE aptbooks_readonly NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO aptbooks_migrator, aptbooks_runtime, aptbooks_readonly', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO aptbooks_runtime, aptbooks_readonly;
GRANT USAGE, CREATE ON SCHEMA public TO aptbooks_migrator;

-- Existing objects. The migrator should own DDL objects in a new production
-- database. For an existing database, transfer ownership under change control
-- before using the runtime role.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aptbooks_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO aptbooks_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO aptbooks_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO aptbooks_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aptbooks_readonly;

-- Migration history is not application data and the runtime must not mutate it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE schema_migrations FROM aptbooks_runtime;
GRANT SELECT ON TABLE schema_migrations TO aptbooks_runtime;

-- Future objects created by the migrator get the same least-privilege grants.
ALTER DEFAULT PRIVILEGES FOR ROLE aptbooks_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aptbooks_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE aptbooks_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO aptbooks_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE aptbooks_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO aptbooks_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE aptbooks_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO aptbooks_readonly;

-- Defense in depth: prevent a future administrator from casually granting RLS
-- bypass through role inheritance.
REVOKE aptbooks_migrator FROM aptbooks_runtime;
REVOKE aptbooks_migrator FROM aptbooks_readonly;
