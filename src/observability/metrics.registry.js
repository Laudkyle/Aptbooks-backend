function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function keyFor(labels) {
  return Object.keys(labels || {}).sort().map((key) => `${key}=${String(labels[key])}`).join('|');
}

function labelsText(labels) {
  const entries = Object.entries(labels || {});
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

class MetricRegistry {
  constructor() {
    this.definitions = new Map();
    this.values = new Map();
  }

  define(name, { help, type, buckets = [] }) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`Invalid metric name: ${name}`);
    const existing = this.definitions.get(name);
    if (existing) return existing;
    const definition = { name, help, type, buckets: [...buckets].sort((a, b) => a - b) };
    this.definitions.set(name, definition);
    this.values.set(name, new Map());
    return definition;
  }

  counter(name, help) {
    this.define(name, { help, type: 'counter' });
    return { inc: (labels = {}, amount = 1) => this.increment(name, labels, amount) };
  }

  gauge(name, help) {
    this.define(name, { help, type: 'gauge' });
    return {
      set: (labels = {}, value) => this.set(name, labels, value),
      inc: (labels = {}, amount = 1) => this.increment(name, labels, amount),
      dec: (labels = {}, amount = 1) => this.increment(name, labels, -amount),
    };
  }

  histogram(name, help, buckets) {
    this.define(name, { help, type: 'histogram', buckets });
    return { observe: (labels = {}, value) => this.observe(name, labels, value) };
  }

  entry(name, labels) {
    const map = this.values.get(name);
    if (!map) throw new Error(`Metric not defined: ${name}`);
    const key = keyFor(labels);
    if (!map.has(key)) map.set(key, { labels: { ...labels }, value: 0, sum: 0, count: 0, buckets: new Map() });
    return map.get(key);
  }

  increment(name, labels, amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return;
    this.entry(name, labels).value += n;
  }

  set(name, labels, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    this.entry(name, labels).value = n;
  }

  observe(name, labels, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const definition = this.definitions.get(name);
    const entry = this.entry(name, labels);
    entry.sum += n;
    entry.count += 1;
    for (const bucket of definition.buckets) {
      if (n <= bucket) entry.buckets.set(bucket, (entry.buckets.get(bucket) || 0) + 1);
    }
  }

  render() {
    const lines = [];
    for (const definition of this.definitions.values()) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);
      for (const entry of this.values.get(definition.name).values()) {
        if (definition.type === 'histogram') {
          for (const bucket of definition.buckets) {
            lines.push(`${definition.name}_bucket${labelsText({ ...entry.labels, le: bucket })} ${entry.buckets.get(bucket) || 0}`);
          }
          lines.push(`${definition.name}_bucket${labelsText({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
          lines.push(`${definition.name}_sum${labelsText(entry.labels)} ${entry.sum}`);
          lines.push(`${definition.name}_count${labelsText(entry.labels)} ${entry.count}`);
        } else {
          lines.push(`${definition.name}${labelsText(entry.labels)} ${entry.value}`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

const registry = new MetricRegistry();
const httpRequests = registry.counter('aptbooks_http_requests_total', 'HTTP requests completed');
const http5xx = registry.counter('aptbooks_http_5xx_total', 'HTTP responses with 5xx status');
const httpInFlight = registry.gauge('aptbooks_http_requests_in_flight', 'HTTP requests currently in flight');
const httpDuration = registry.histogram('aptbooks_http_request_duration_seconds', 'HTTP request duration in seconds', [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30]);
const dbDuration = registry.histogram('aptbooks_db_query_duration_seconds', 'Database query duration in seconds', [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30]);
const dbErrors = registry.counter('aptbooks_db_query_errors_total', 'Database query errors');
const dbPoolTotal = registry.gauge('aptbooks_db_pool_connections_total', 'Total PostgreSQL pool connections');
const dbPoolIdle = registry.gauge('aptbooks_db_pool_connections_idle', 'Idle PostgreSQL pool connections');
const dbPoolWaiting = registry.gauge('aptbooks_db_pool_waiting_requests', 'Requests waiting for a PostgreSQL pool connection');
const schedulerRuns = registry.counter('aptbooks_scheduler_runs_total', 'Scheduled task runs by terminal status');
const schedulerDuration = registry.histogram('aptbooks_scheduler_run_duration_seconds', 'Scheduled task run duration in seconds', [0.1, 0.5, 1, 5, 15, 30, 60, 300, 900, 3600]);
const schedulerFailures = registry.counter('aptbooks_scheduler_failures_total', 'Scheduled task failures');
const integrityRuns = registry.counter('aptbooks_accounting_integrity_runs_total', 'Financial integrity runs by terminal status');
const integrityFailures = registry.counter('aptbooks_accounting_integrity_failures_total', 'Financial integrity execution or check failures');
const processUp = registry.gauge('aptbooks_process_up', 'Whether the AptBooks process is running');
const processUptime = registry.gauge('aptbooks_process_uptime_seconds', 'Process uptime in seconds');
const processRss = registry.gauge('aptbooks_process_resident_memory_bytes', 'Process resident memory bytes');
const draining = registry.gauge('aptbooks_process_draining', 'Whether the process is draining before shutdown');
const sloAvailabilityTarget = registry.gauge('aptbooks_slo_availability_target_percent', 'Configured API availability SLO target percent');
const sloP95LatencyTarget = registry.gauge('aptbooks_slo_p95_latency_target_seconds', 'Configured API p95 latency SLO target seconds');
const buildInfo = registry.gauge('aptbooks_build_info', 'AptBooks build/release metadata');

processUp.set({}, 1);

module.exports = {
  MetricRegistry,
  registry,
  metrics: {
    httpRequests, http5xx, httpInFlight, httpDuration,
    dbDuration, dbErrors, dbPoolTotal, dbPoolIdle, dbPoolWaiting,
    schedulerRuns, schedulerDuration, schedulerFailures,
    integrityRuns, integrityFailures,
    processUp, processUptime, processRss, draining, sloAvailabilityTarget, sloP95LatencyTarget, buildInfo,
  },
};
