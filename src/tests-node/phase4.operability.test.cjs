const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { parseTraceparent, createServerTrace } = require('../observability/trace');
const { MetricRegistry } = require('../observability/metrics.registry');
const { runPhase4OperabilityGate } = require('../quality/phase4-operability-gate');

// Dependency-free tests for the operational kernel. Full HTTP/DB tests remain
// in the complete repository where Express/PostgreSQL dependencies exist.
test('W3C traceparent parser rejects malformed/zero identifiers', () => {
  assert.equal(parseTraceparent('garbage'), null);
  assert.equal(parseTraceparent('00-00000000000000000000000000000000-1111111111111111-01'), null);
  assert.equal(parseTraceparent('00-11111111111111111111111111111111-0000000000000000-01'), null);
  assert.deepEqual(parseTraceparent('00-11111111111111111111111111111111-2222222222222222-01'), {
    traceId: '11111111111111111111111111111111', parentSpanId: '2222222222222222', flags: '01'
  });
});

test('server tracing continues incoming trace id with a fresh span id', () => {
  const trace = createServerTrace('00-11111111111111111111111111111111-2222222222222222-01', 0);
  assert.equal(trace.traceId, '11111111111111111111111111111111');
  assert.equal(trace.parentSpanId, '2222222222222222');
  assert.match(trace.spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(trace.spanId, trace.parentSpanId);
  assert.equal(trace.sampled, true);
});

test('metrics registry renders counters and cumulative histogram buckets', () => {
  const registry = new MetricRegistry();
  const c = registry.counter('test_requests_total', 'requests');
  const h = registry.histogram('test_duration_seconds', 'duration', [0.1, 1]);
  c.inc({ route: '/x' }, 2);
  h.observe({ route: '/x' }, 0.5);
  const text = registry.render();
  assert.match(text, /test_requests_total\{route="\/x"\} 2/);
  assert.match(text, /test_duration_seconds_bucket\{route="\/x",le="0\.1"\} 0|test_duration_seconds_bucket\{le="0\.1",route="\/x"\} 0/);
  assert.match(text, /test_duration_seconds_count\{route="\/x"\} 1/);
});

test('Phase 4 operability architecture gate passes', () => {
  assert.deepEqual(runPhase4OperabilityGate(), []);
});


test('database pool release wrapper is checkout-local and cannot reuse stale pg-pool release closures', () => {
  const poolSource = fs.readFileSync(path.join(__dirname, '..', 'db', 'pool.js'), 'utf8');
  assert.doesNotMatch(poolSource, /ORIGINAL_RELEASE|aptbooks\.originalRelease/);
  assert.match(poolSource, /const originalRelease = client\.release\.bind\(client\)/);
  assert.match(poolSource, /client\.release = originalRelease/);
});
