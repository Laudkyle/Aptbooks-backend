# AptBooks Engineering Standards

This file is normative for new code. Existing exceptions are recorded by the Phase 3 debt baselines and may be reduced, never increased.

## Boundaries

- `core/accounting` is the financial kernel. New dependencies from it into `modules`, `reporting`, or `compliance` are forbidden.
- HTTP route modules authenticate, authorize, validate and translate transport concerns. They do not become data-access layers.
- Services orchestrate domain behavior and transactions. New direct `pool.query()` usage in services is forbidden; SQL belongs in repositories or narrowly scoped infrastructure adapters.
- Repositories own SQL and database row mapping. New `SELECT *` usage is forbidden; select explicit columns.
- Frontend features may depend on `shared` and `app` contracts. New feature-to-feature imports are forbidden unless an explicit boundary decision is recorded.

## Financial code

Every book-affecting command must remain authenticated, authorized, tenant-scoped, validated, idempotent where retried, atomic, exact-decimal safe, period-aware, auditable, concurrency-safe and routed through the canonical posting engine.

Financial API amounts are decimal strings at boundaries. Do not introduce native floating-point arithmetic into financial decision paths.

## Database access

Use `shared/db/repositoryStandard.js` for new repositories. Validate organization context at the repository boundary when data is tenant-owned. Use explicit column lists and parameterized SQL. RLS is defense in depth, not a substitute for tenant predicates.

Runtime database identities must remain separate from migration identities. Historical migrations are immutable and checksum-protected.

## HTTP/API

All request bodies are covered by the validation framework. New endpoints must have explicit validation schemas rather than being added to the legacy generic-body contract. Errors use the canonical machine-readable envelope and stable codes.

## Size budgets

New backend runtime modules must stay at or below 800 lines; route modules at or below 700 lines. New frontend runtime modules must stay at or below 700 lines; route modules at or below 500 lines; endpoint modules at or below 350 lines. Smaller cohesive modules are preferred. Legacy exceptions cannot grow.

## Type strategy

New domain contracts should be expressed first in the strict Phase 3 TypeScript contract layer. Runtime conversion from JavaScript is incremental: convert pure domain modules and new code first after the root repository installs/configures TypeScript. Do not rename runtime modules to `.ts` without the full build toolchain and CI typecheck being present.

Branded IDs, decimal strings, local dates, money and accounting commands must not collapse back to untyped `string`/`number` contracts in new TypeScript code.

## Frontend routing and API registry

`app/routes/index.jsx` is a composition root only. Route policy belongs in bounded modules under `app/routes/modules` and page loading remains centralized through `lazy-pages.jsx`.

`shared/api/endpoints.js` is a compatibility facade only. New endpoint definitions go into the appropriate domain module under `shared/api/endpoints`.

## Testing and gates

A change is not complete unless Phase 1 security, Phase 2 financial assurance, architecture, Phase 3 maintainability, validation and secret-scan gates remain green. Existing debt baselines are ratchets, not targets.

## Operations and reliability

Production releases must identify themselves with `APP_VERSION`, emit structured request/trace correlation, expose protected Prometheus metrics, preserve `/healthz` as a dependency-free liveness check, and make `/readyz` fail when the database/security baseline is unavailable or the process is draining.

New metrics must use bounded-cardinality labels. Tenant IDs, user IDs, account/document IDs, free-form messages, SQL, and financial values are forbidden as metric labels. Slow-query logs may record operation class and duration, never bind values or customer financial payloads.

All new background jobs must emit terminal success/failure observability, be safe to retry, preserve tenant context, and document how operators verify financial side effects after failure. Financial-integrity failures remain critical and may not be downgraded to improve SLO dashboards.

Changes that affect shutdown, database recovery, migrations, scheduler execution, posting, RLS, or backup/restore behavior must update the relevant runbook and be covered by an executable gate or drill where practical. The Phase 4 operability gates are mandatory alongside Phases 1–3.
