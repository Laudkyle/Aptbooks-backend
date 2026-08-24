const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(SRC, rel));

function requireText(errors, file, patterns) {
  if (!exists(file)) { errors.push(`${file}: missing`); return; }
  const source = read(file);
  for (const [label, pattern] of patterns) if (!pattern.test(source)) errors.push(`${file}: missing ${label}`);
}

function runPhase4OperabilityGate() {
  const errors = [];
  for (const file of [
    'observability/context.js',
    'observability/trace.js',
    'observability/metrics.registry.js',
    'observability/httpMetrics.middleware.js',
    'observability/metrics.routes.js',
    'ops/gracefulShutdown.js',
    'ops/alerts/aptbooks-prometheus-rules.yml',
    'ops/slo-definition.json',
    'ops/dr-drill.sh',
    'ops/performance/smoke.js',
    'docs/PHASE4_OPERATIONS_RELIABILITY.md',
    'docs/SLOS_AND_ERROR_BUDGETS.md',
    'docs/INCIDENT_RESPONSE.md',
    'docs/DISASTER_RECOVERY.md',
    'docs/PERFORMANCE_TESTING.md',
    'db/migrations/sql/163_phase4_operational_reliability.sql',
  ]) if (!exists(file)) errors.push(`${file}: missing Phase 4 artifact`);

  requireText(errors, 'app.js', [
    ['trace middleware', /tracingMiddleware/],
    ['HTTP metrics middleware', /httpMetricsMiddleware/],
    ['metrics router', /metricsRouter/],
    ['drain middleware', /requestDrainMiddleware/],
    ['traceparent CORS allowlist', /"traceparent"/],
    ['x-trace-id CORS exposure', /"x-trace-id"/],
  ]);
  requireText(errors, 'config/logger.js', [
    ['trace context mixin', /getObservabilityContext/],
    ['credential redaction', /REDACTED/],
  ]);
  requireText(errors, 'config/env.js', [
    ['metrics token production validation', /METRICS_BEARER_TOKEN must contain at least 32 bytes/],
    ['trace sampling validation', /TRACE_SAMPLE_RATIO must be between 0 and 1/],
    ['shutdown grace', /SHUTDOWN_GRACE_MS/],
  ]);
  requireText(errors, 'db/pool.js', [
    ['DB duration metrics', /metrics\.dbDuration\.observe/],
    ['DB error metrics', /metrics\.dbErrors\.inc/],
    ['slow query warning', /Slow database query/],
  ]);
  requireText(errors, 'utilities/scheduled-tasks/schedulerExecution.service.js', [
    ['scheduler run metrics', /metrics\.schedulerRuns\.inc/],
    ['scheduler failure metrics', /metrics\.schedulerFailures\.inc/],
  ]);
  requireText(errors, 'utilities/scheduled-tasks/accountingIntegrity.jobs.js', [
    ['financial integrity metrics', /metrics\.integrityFailures\.inc/],
  ]);
  requireText(errors, 'health/health.routes.js', [
    ['drain-aware readiness', /isDraining\(\)/],
    ['Phase 4 migration readiness', /163_phase4_operational_reliability\.sql/],
  ]);

  const alerts = exists('ops/alerts/aptbooks-prometheus-rules.yml') ? read('ops/alerts/aptbooks-prometheus-rules.yml') : '';
  for (const alert of ['AptBooksApiDown', 'AptBooksHighServerErrorRate', 'AptBooksDatabasePoolSaturation', 'AptBooksSchedulerFailures', 'AptBooksFinancialIntegrityFailure']) {
    if (!alerts.includes(alert)) errors.push(`alert rules: missing ${alert}`);
  }
  if (/organization[_-]?id|user[_-]?id|account[_-]?id/i.test(read('observability/metrics.registry.js'))) {
    errors.push('metrics.registry.js: metric definitions must not use tenant/user/account identifiers as labels');
  }

  const slo = JSON.parse(read('ops/slo-definition.json'));
  if (Number(slo?.objectives?.financialIntegrityCriticalFailures) !== 0) errors.push('SLO: financial integrity critical-failure objective must remain zero');
  if (Number(slo?.objectives?.availabilityPercent) < 99.9) errors.push('SLO: availability target must not fall below Phase 4 baseline 99.9%');
  return errors;
}

module.exports = { runPhase4OperabilityGate };

if (require.main === module) {
  const errors = runPhase4OperabilityGate();
  if (errors.length) {
    console.error(`Phase 4 operability gate failed (${errors.length}):`);
    errors.forEach((error) => console.error(` - ${error}`));
    process.exitCode = 1;
  } else {
    console.log('Phase 4 operability gate passed.');
  }
}
