const crypto = require('crypto');
const { runWithObservabilityContext } = require('./context');

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function randomHex(bytes) {
  let value = '';
  do { value = crypto.randomBytes(bytes).toString('hex'); } while (/^0+$/.test(value));
  return value;
}

function parseTraceparent(value) {
  const match = TRACEPARENT_RE.exec(String(value || '').trim());
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1].toLowerCase(), parentSpanId: match[2].toLowerCase(), flags: match[3].toLowerCase() };
}

function shouldSample(parent, ratio) {
  if (parent) return (parseInt(parent.flags, 16) & 1) === 1;
  const bounded = Math.min(1, Math.max(0, Number(ratio) || 0));
  return Math.random() < bounded;
}

function createServerTrace(traceparent, sampleRatio) {
  const parent = parseTraceparent(traceparent);
  const traceId = parent?.traceId || randomHex(16);
  const spanId = randomHex(8);
  const sampled = shouldSample(parent, sampleRatio);
  const flags = sampled ? '01' : '00';
  return {
    traceId,
    spanId,
    parentSpanId: parent?.parentSpanId || null,
    sampled,
    traceparent: `00-${traceId}-${spanId}-${flags}`,
  };
}

function tracingMiddleware({ sampleRatio = 0.1 } = {}) {
  return function aptbooksTracingMiddleware(req, res, next) {
    const trace = createServerTrace(req.headers.traceparent, sampleRatio);
    req.trace = trace;
    res.setHeader('traceparent', trace.traceparent);
    res.setHeader('x-trace-id', trace.traceId);
    runWithObservabilityContext({
      requestId: req.request_id || null,
      traceId: trace.traceId,
      spanId: trace.spanId,
      sampled: trace.sampled,
    }, next);
  };
}

module.exports = { parseTraceparent, createServerTrace, tracingMiddleware };
