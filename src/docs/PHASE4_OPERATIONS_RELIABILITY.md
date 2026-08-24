# Phase 4 — Operations & Reliability

Phase 4 turns the Phase 1–3 accounting application into an operable production service. It does not change AptBooks from JavaScript to TypeScript.

## Runtime controls

- W3C `traceparent` is accepted, validated and continued for every HTTP request. The API returns `traceparent` and `x-trace-id` so browser/support incidents can be correlated with server logs.
- Pino logs include service, environment, version, request ID and trace/span IDs. Credential-like fields are redacted.
- Prometheus-compatible metrics are exposed at `METRICS_PATH` (default `/metrics`) and require a strong bearer token in production.
- HTTP metrics use normalized route labels to avoid UUID/numeric-cardinality explosions.
- PostgreSQL one-off queries record latency and errors; slow queries emit metadata-only warnings without SQL or bind values.
- Scheduler runs and financial-integrity checks emit dedicated metrics.
- `/readyz` becomes unavailable while draining and requires migration 163 in RLS-enabled environments. `/healthz` remains a liveness check.
- `requestDrainMiddleware` rejects new application requests with a retryable 503 after drain starts. The complete repository's HTTP-server bootstrap must call `installGracefulShutdown(...)` with the actual `server`, scheduler stop callback and pool.

## Production environment additions

Set `SERVICE_NAME`, `APP_VERSION`, `METRICS_ENABLED=true`, a random `METRICS_BEARER_TOKEN` of at least 32 bytes, `TRACE_SAMPLE_RATIO`, `SLOW_REQUEST_MS`, `SLOW_DB_QUERY_MS`, `SHUTDOWN_GRACE_MS`, `SLO_AVAILABILITY_TARGET`, and `SLO_P95_LATENCY_MS`.

The metrics token is an operations credential. Keep `/metrics` network-restricted even though it is bearer protected. Do not expose it to the browser application.

## Tracing

AptBooks implements W3C trace-context propagation without requiring an SDK. When the full project toolchain is available, an OpenTelemetry Node SDK/exporter can be installed around this context without changing the public headers. Trace sampling defaults to 10% in production and 100% outside production. Incoming sampled traces preserve the caller's sampling decision.

## Metrics

Primary service metrics are `aptbooks_http_requests_total`, `aptbooks_http_5xx_total`, `aptbooks_http_request_duration_seconds`, `aptbooks_http_requests_in_flight`, `aptbooks_db_query_duration_seconds`, `aptbooks_db_query_errors_total`, PostgreSQL pool gauges, scheduler run/failure metrics, and financial-integrity run/failure metrics.

Metrics intentionally do not contain organization IDs, user IDs, account IDs, invoice IDs, free-form error messages, SQL, or financial values.

## SLO and alerts

The normative starting SLO is in `ops/slo-definition.json`. Prometheus alert rules are in `ops/alerts/aptbooks-prometheus-rules.yml`. Adjust numeric objectives only through an explicit reliability review; do not silently weaken alerts to make dashboards green.

A financial-integrity failure is a critical alert even if HTTP availability is otherwise healthy.

## Disaster recovery

`ops/dr-drill.sh` restores an existing verified backup to a disposable target using `ops/restore-postgres.sh`, runs post-restore accounting verification, measures elapsed time against `DR_RTO_SECONDS`, and writes evidence. The drill refuses to run unless `APTBOOKS_DR_DRILL_CONFIRM=RESTORE_TO_DISPOSABLE_TARGET` is supplied.

Never run a DR drill against the production primary database.

## Performance acceptance

`ops/performance/smoke.js` is a dependency-free, GET-only performance gate for staging. It defaults to `/healthz,/readyz`, never performs financial mutations, and fails when p95 latency or error-rate budgets are exceeded. A mature load program should add representative authenticated read scenarios in the full repository without using live customer data.

## Release acceptance

Before a production release, run the Phase 1–4 quality gates, the full dependency/build/test suite in the complete repositories, migration rehearsal against a production-like PostgreSQL clone, RLS tests, the read-only performance smoke, metrics scrape verification, alert-rule validation in the monitoring platform, and at least one documented restore drill per recovery-policy interval.
