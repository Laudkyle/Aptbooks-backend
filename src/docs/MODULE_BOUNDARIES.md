# Module Boundaries

## Backend dependency direction

Preferred direction:

`HTTP -> application/service -> domain -> repository/infrastructure -> database`

Cross-cutting platform concerns (`auth`, `authorization`, `audit`, `idempotency`, `tenant context`, `logging`) may be consumed through their public interfaces.

The accounting kernel must not gain new upward imports into application modules, reporting or compliance. The Phase 3 gate snapshots current legacy exceptions so they can be removed over time without allowing new ones.

## Repository ownership

Repositories are the only preferred home for new SQL. Services may own transaction boundaries by acquiring a client and passing it down. Repositories must accept that client so all book-affecting writes can participate in the caller's transaction.

## Frontend dependency direction

Preferred direction:

`app composition -> feature -> shared`

Feature-to-feature imports are legacy debt. The Phase 3 baseline prevents new cross-feature imports. Shared modules must remain domain-neutral; business rules should not be moved to `shared` merely to bypass the boundary gate.
