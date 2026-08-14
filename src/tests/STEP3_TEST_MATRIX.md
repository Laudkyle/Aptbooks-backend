# Step 3 accounting hardening test matrix

These tests are intentionally source-only additions so they can be dropped into the complete repository without changing package/bootstrap files that were omitted from the review archive.

## Fast tests with no external packages

Backend:

    node --test src/tests-node/*.test.cjs

Frontend:

    node --test src/tests/*.test.cjs src/tests/*.test.mjs

## Database/API integration suites

Run the Jest/Supertest suites with the project's normal test command after applying migrations through `144_step2_ledger_source_of_truth.sql` to an isolated PostgreSQL test database.

Coverage added in Step 3:

- exact money parsing and round-half-up FX boundaries
- temporary draft imbalance versus submit-time double-entry enforcement
- minimum two-line enforcement
- partial line PATCH validation
- tenant isolation at API and database constraint/trigger layers
- concurrent journal posting
- concurrent idempotent journal creation
- period close/post race integrity
- refresh-token rotation/reuse and logout revocation
- transaction-bound webhook outbox rollback
- concurrent webhook dispatcher claims
- webhook SSRF rejection
- canonical journal-derived ledger reconciliation
- rebuild of the GL projection from posted journal history
- reversal/void source-of-truth behavior
- frontend journal lifecycle permissions and API/route contracts

The database suites bootstrap and delete isolated QA organizations. They should never be pointed at a production database.
