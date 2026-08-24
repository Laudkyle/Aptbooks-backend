# Phase 3 — Maintainability and Standardization

Phase 3 turns the Phase 1 security and Phase 2 financial-assurance work into an architecture that is harder to regress as AptBooks grows.

## Delivered

- Frontend routing split from a 2,439-line registry into bounded-context route modules and a small composition root.
- Frontend API endpoint registry split into domain modules behind the existing `endpoints.*` facade.
- Backend tax routing split from a 1,545-line router into setup, compliance, returns/integrations and withholding route modules while preserving route registration order.
- Accounting-policy SQL moved behind a repository interface, preserving service-level transaction/orchestration responsibility.
- New repository standard with explicit-column, tenant-context and common query helpers.
- Strict TypeScript contract foundations for branded IDs, money, posting commands, accounting policy and API envelopes.
- Backend debt ratchets for `SELECT *`, direct service/route pool access, oversized modules and accounting-kernel upward dependencies.
- Frontend debt ratchets for oversized modules and cross-feature imports.
- Engineering standards, module-boundary rules and an incremental TypeScript migration policy.

## Compatibility

The Phase 3 refactors preserve the public runtime facade. Existing frontend code still imports `endpoints` from `shared/api/endpoints.js`; existing application bootstrap still imports the router from `app/routes/index.jsx`; backend application mounting still imports `tax.routes.js`.

Behavior-preservation verification compares the Phase 2 archive against Phase 3 and confirms all 137 backend tax method/path registrations, all 274 frontend `ROUTES.*` references and all 625 endpoint path literals are preserved.

## Debt ratchet policy

The JSON files under `quality/phase3-debt-baseline.json` describe existing debt, not acceptable new practice. Gates allow the listed legacy occurrences only at or below their Phase 3 counts. A cleanup should lower the baseline in the same change; feature work must not raise it.
