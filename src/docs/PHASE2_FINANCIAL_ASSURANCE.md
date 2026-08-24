# Phase 2 Financial Assurance

Phase 2 turns the Phase 1-secured application boundary into a financially auditable accounting platform. The invariant is simple: **posted journal history is the source of truth; everything else is a controlled command, immutable provenance, or a rebuildable/reconcilable projection.**

## Implemented controls

### Canonical posting engine

All Tier >= 2 modules continue to depend on `interfaces/journalPosting.interface.js`, but that interface now routes posting mutations through `core/accounting/posting/postingEngine.service.js`.

The engine provides:

- normalized posting invariants before one-shot posting;
- a domain-level idempotency claim keyed by `(organization_id, idempotency_key)`;
- SHA-256 request fingerprints, so the same key cannot represent different financial commands;
- one-transaction create+post behavior for `postJournal`;
- immutable journal posting provenance;
- accounting-policy version resolution at the posting date;
- provenance for normal postings, batch postings, void reversals, and cross-period reversals;
- source-aware posting via `postSourceJournal` for operational domains.

Higher-tier runtime code is prohibited by the Phase 2 quality gate from importing the journal service directly or writing `general_ledger_balances` directly.

### Accounting policy layer

`accounting_policy_versions` stores immutable effective-dated policy snapshots. The currently supported policy deliberately mirrors rules already implemented by the accounting kernel:

- money scale: 2;
- exchange-rate scale: 6;
- inventory valuation scale: 6;
- rounding: `HALF_UP`;
- tax rounding scope: `LINE`;
- posting date: `DOCUMENT_DATE`;
- closed-period adjustment: `REJECT`;
- reversal: `EXPLICIT_REVERSAL`.

Unsupported values are rejected instead of being stored as configuration the engine cannot honor. A newly published policy cannot be back-dated across already-posted financial history. Each Phase 2 posting records the exact policy version used.

### Financial integrity runner

`POST /core/accounting/integrity/run` performs and optionally persists these checks:

1. every posted/voided journal balances in base currency;
2. every journal date belongs to its selected accounting period;
3. `general_ledger_balances` exactly matches totals recomputed from immutable posted journal lines;
4. active invoices, bills, receipts, vendor payments, and inventory transactions have valid posted-journal links;
5. current base-currency AR open items reconcile to configured receivable control accounts;
6. current base-currency AP open items reconcile to configured payable control accounts;
7. current inventory valuation reconciles to inventory control accounts;
8. journal-origin bank transactions retain journal provenance;
9. journals created after migration 162 have immutable Phase 2 posting provenance.

Findings are persisted in `financial_integrity_runs` and `financial_integrity_findings` with `info`, `warning`, `error`, or `critical` severity. A tenant-scoped scheduler task (`accounting.financial_integrity.daily`) runs the suite daily at 00:30 UTC and persists evidence for each organization. Critical/error findings make a run `failed`; warnings make it `warnings`; otherwise it is `passed`.

AR/AP historical-as-of reconciliation is intentionally not fabricated from current open-item views. Historical requests receive an informational coverage finding until historical base-currency subledger snapshots are introduced. Foreign-currency open items are also reported as a coverage limitation instead of being silently compared at nominal transaction-currency amounts against base-currency GL balances.

### Subledger assurance

The Phase 2 runner covers AR, AP, inventory, bank provenance, and primary operational-source links. This does not replace bank statement reconciliation, tax-to-GL reconciliation, or compliance-module reconciliation already present elsewhere in AptBooks; it provides the cross-cutting financial-control view that proves the accounting kernel and major subledgers are coherent.

### Financial test suite

`tests-node/phase2.financial-assurance.test.cjs` includes:

- golden-master postings for cash sales, credit sales, receipts, bills, and vendor payments;
- reversal-to-zero guarantees;
- stable/different posting-fingerprint checks;
- 2,000 deterministic generated balanced journals with reversal invariants;
- rejection of invalid one-sided and unbalanced postings.

Existing concurrency tests remain applicable, and `tests/phase2.financial-assurance.integration.test.js` adds live-database provenance/integrity coverage for the complete repository test environment.

## Frontend

The existing Accounting > Reconciliation workspace now exposes a **Financial Integrity** panel. It can run the cross-cutting integrity suite, display the latest status and severity counts, surface the first findings, and show the effective immutable accounting-policy version without replacing the more detailed ledger reconciliation workflow.

## Deployment acceptance

Before Phase 2 is approved in production:

1. apply migration `162_phase2_financial_assurance.sql` with the dedicated migrator role;
2. run Phase 1 security gates and Phase 2 financial-assurance gate;
3. run `db/admin/verify_financial_assurance.sql` under each representative production tenant context;
4. run the complete backend integration test suite against a staging clone, including concurrency tests;
5. run the complete frontend build/test suite;
6. verify no post-Phase-2 journal lacks `journal_posting_provenance`;
7. run an integrity check for every tenant and investigate all `critical`/`error` findings before cut-over.

The source-only artifacts still cannot prove package dependency audits, production builds, or live PostgreSQL behavior without the full repositories and staging database.
