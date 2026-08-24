#!/usr/bin/env node
'use strict';

const { performance } = require('perf_hooks');

function envNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

const baseUrl = String(process.env.PERF_BASE_URL || '').replace(/\/$/, '');
if (!baseUrl) throw new Error('PERF_BASE_URL is required, e.g. https://staging-api.example.com');
const paths = String(process.env.PERF_PATHS || '/healthz,/readyz').split(',').map((v) => v.trim()).filter(Boolean);
for (const path of paths) if (!path.startsWith('/')) throw new Error(`PERF_PATHS entries must be absolute paths: ${path}`);
const durationSeconds = envNumber('PERF_DURATION_SECONDS', 30);
const concurrency = Math.floor(envNumber('PERF_CONCURRENCY', 10));
const p95BudgetMs = envNumber('PERF_P95_BUDGET_MS', 1000);
const maxErrorRate = Number(process.env.PERF_MAX_ERROR_RATE || '0.01');
if (!Number.isFinite(maxErrorRate) || maxErrorRate < 0 || maxErrorRate > 1) throw new Error('PERF_MAX_ERROR_RATE must be between 0 and 1');

const deadline = Date.now() + durationSeconds * 1000;
const latencies = [];
let total = 0;
let errors = 0;
let cursor = 0;

async function worker() {
  while (Date.now() < deadline) {
    const path = paths[cursor++ % paths.length];
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}${path}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000) });
      if (response.status >= 500 || response.status === 429) errors += 1;
      await response.arrayBuffer();
    } catch (_) {
      errors += 1;
    } finally {
      latencies.push(performance.now() - started);
      total += 1;
    }
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

(async () => {
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedSeconds = durationSeconds;
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);
  const errorRate = total ? errors / total : 1;
  const report = {
    baseUrl,
    paths,
    durationSeconds,
    concurrency,
    totalRequests: total,
    requestsPerSecond: Number((total / elapsedSeconds).toFixed(2)),
    errors,
    errorRate: Number(errorRate.toFixed(6)),
    latencyMs: { p50: Number(p50.toFixed(2)), p95: Number(p95.toFixed(2)), p99: Number(p99.toFixed(2)) },
    budgets: { p95Ms: p95BudgetMs, maxErrorRate },
    passed: p95 <= p95BudgetMs && errorRate <= maxErrorRate,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
})().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 2;
});
