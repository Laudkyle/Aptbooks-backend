const crypto = require('crypto');
const express = require('express');
const { env } = require('../config/env');
const { pool } = require('../db/pool');
const { registry, metrics } = require('./metrics.registry');
const { isDraining } = require('../ops/gracefulShutdown');

const router = express.Router();

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function authorize(req, res, next) {
  if (!env.METRICS_ENABLED) return res.status(404).end();
  if (!env.METRICS_BEARER_TOKEN) return next();
  const value = String(req.headers.authorization || '');
  const token = value.startsWith('Bearer ') ? value.slice(7) : '';
  if (!safeEqual(token, env.METRICS_BEARER_TOKEN)) return res.status(401).set('WWW-Authenticate', 'Bearer').end();
  next();
}

router.get(env.METRICS_PATH, authorize, (_req, res) => {
  metrics.processUptime.set({}, process.uptime());
  metrics.processRss.set({}, process.memoryUsage().rss);
  metrics.draining.set({}, isDraining() ? 1 : 0);
  metrics.sloAvailabilityTarget.set({}, env.SLO_AVAILABILITY_TARGET);
  metrics.sloP95LatencyTarget.set({}, env.SLO_P95_LATENCY_MS / 1000);
  metrics.buildInfo.set({ service: env.SERVICE_NAME, version: env.APP_VERSION, environment: env.NODE_ENV }, 1);
  metrics.dbPoolTotal.set({}, pool.totalCount || 0);
  metrics.dbPoolIdle.set({}, pool.idleCount || 0);
  metrics.dbPoolWaiting.set({}, pool.waitingCount || 0);
  res.set('Cache-Control', 'no-store');
  res.type('text/plain; version=0.0.4; charset=utf-8').send(registry.render());
});

module.exports = { metricsRouter: router, authorize };
