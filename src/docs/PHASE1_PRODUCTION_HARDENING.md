# Phase 1 Production Hardening

This source tree implements the Phase 1 application controls required before AptBooks handles production financial data. Deployment is accepted only after the live-environment checks below also pass.

## Implemented in source

- **Session security:** production refresh credentials are HttpOnly/Secure cookie-only; frontend access credentials are memory-only; credential-cookie endpoints enforce trusted browser origins.
- **Authentication abuse controls:** production uses a shared PostgreSQL rate-limit store; login/password-reset limits fail closed; rate-limit keys do not store raw email addresses.
- **Request contracts:** all route modules consuming `req.body` run through structural request safety plus an explicit domain schema or strict legacy-module contract. Security-sensitive accounting/admin endpoints have typed Zod schemas.
- **Error contract:** errors expose a stable machine code, message, details, and request ID while retaining temporary compatibility fields.
- **Tenant isolation:** authenticated execution carries organization context via AsyncLocalStorage. Every pooled PostgreSQL checkout applies and later scrubs tenant state. Migration `161_phase1_row_level_tenant_isolation.sql` enables and forces RLS for tenant-owned tables and recursively protects child/detail tables through protected foreign-key parents.
- **Background work:** scheduled accounting/reporting/maintenance jobs and webhook delivery establish an explicit tenant context per organization instead of using `BYPASSRLS`.
- **Database roles:** the runtime role is expected to be least privilege, not own tables, and have no `BYPASSRLS`; migrations use a separate connection/identity. `/readyz` fails when the production baseline is absent or the runtime identity is over-privileged.
- **Migration integrity:** applied SQL files are SHA-256 recorded; changed/missing historical migrations fail; each migration and its ledger record is runner-transactional.
- **Backups:** provided scripts create checksum-protected PostgreSQL custom-format backups, refuse accidental restore, and run posted-journal balance verification after restore. Credentials are not placed in command arguments.
- **Production exposure:** Swagger and internal utility/test routes default off in production; insecure production environment combinations fail during startup.

## RLS bootstrap exclusions

The following tables intentionally remain outside tenant RLS because they establish identity/tenant context or are global operational state: `organizations`, `users`, `user_organizations`, `api_keys`, `refresh_tokens`, `password_reset_tokens`, `email_two_factor_challenges`, `login_history`, `error_logs`, `rate_limit_windows`, `schema_migrations`, `scheduled_tasks`, `scheduled_task_runs`, and `scheduled_task_lock`.

This is not permission to expose those tables through APIs. Their services must continue to authenticate, authorize, and scope access explicitly.

## Production deployment acceptance gates

1. Run migrations using the dedicated migrator identity and confirm migration 161 applies successfully to a staging copy of production data.
2. Connect as the runtime identity and run `db/admin/verify_production_security.sql`.
3. Run the backend and frontend Phase 1 static security gates in CI.
4. Run the full package-manager dependency audit, unit/domain/integration tests, and production builds from the complete repositories. The source-only archives used for this hardening did not contain `package.json`, lockfiles, or installed dependencies, so these cannot be proven from this artifact alone.
5. Configure managed PostgreSQL continuous WAL/PITR, encrypted off-site backup retention, and database/server encryption. The shell backup is an additional portable backup, not a substitute for PITR.
6. Perform an actual restore drill into an isolated database and run `db/admin/post_restore_verify.sql`; record RPO/RTO results.
7. Store application/database secrets in the deployment platform's secret manager. Do not commit a populated `.env`.
8. Enable CI secret scanning, dependency/SCA scanning, SAST, and container scanning in the full repository.
9. Confirm frontend and API are served only over HTTPS and cookie/CORS settings match the exact production origins.

## Migration rule going forward

Released migration files are immutable. Fixes require a new migration. Every future tenant-owned table must receive `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and a fail-closed tenant policy in the migration that creates it. The runtime role must never receive `BYPASSRLS` to compensate for a worker or query that lacks tenant context.

## Backup credentials

`ops/backup-postgres.sh` and `ops/restore-postgres.sh` use standard libpq environment/IAM authentication (`PGPASSFILE`, `PGPASSWORD`, workload identity, etc.). They intentionally do not accept a credential-bearing database URL argument, avoiding secrets in the process command line.
