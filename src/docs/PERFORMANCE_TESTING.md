# Performance Testing

The Phase 4 performance gate is intentionally read-only. Run `ops/performance/smoke.js` against staging or an isolated performance environment, never against a customer production workload without an approved test plan. Configure `PERF_BASE_URL`, duration, concurrency, p95 budget and error-rate budget through environment variables.

The dependency-free smoke validates service/proxy/database responsiveness through health/readiness paths. The complete repository should later add representative authenticated report, journal-list, invoice-list and reconciliation read scenarios using synthetic tenant data, while mutation/load tests must create disposable data and preserve idempotency semantics.

Performance regressions should be reviewed alongside PostgreSQL pool waiting, DB query histograms, HTTP p95/p99 latency, scheduler lag and process memory. Do not optimize by bypassing RLS, validation, audit, idempotency or accounting-integrity controls.
