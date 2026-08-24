# Runbook: high latency

Check p95/p99 HTTP duration, PostgreSQL query duration and pool waiting. Identify bounded route labels with the largest contribution. Inspect slow-query warnings without logging SQL parameters. Verify scheduler load and reporting jobs are not saturating the database. Prefer query/index/caching fixes that preserve RLS and accounting source-of-truth rules. Validate improvement with the Phase 4 read-only performance gate.
