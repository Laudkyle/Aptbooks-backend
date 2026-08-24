const { metrics } = require('./metrics.registry');
const logger = require('../config/logger');
const { env } = require('../config/env');

function normalizePath(pathname) {
  return String(pathname || '/')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/(\d+)(?=\/|$)/g, '/:id')
    .slice(0, 160);
}

function routeLabel(req) {
  if (req.route?.path) return normalizePath(`${req.baseUrl || ''}${req.route.path}`);
  return normalizePath(String(req.originalUrl || req.url || '/').split('?')[0]);
}

function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  metrics.httpInFlight.inc();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    metrics.httpInFlight.dec();
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = {
      method: String(req.method || 'UNKNOWN').toUpperCase(),
      route: routeLabel(req),
      status_class: `${Math.floor((res.statusCode || 0) / 100)}xx`,
    };
    metrics.httpRequests.inc(labels);
    metrics.httpDuration.observe(labels, seconds);
    if ((res.statusCode || 0) >= 500) metrics.http5xx.inc({ method: labels.method, route: labels.route });
    if (seconds * 1000 >= env.SLOW_REQUEST_MS) {
      logger.warn({ method: labels.method, route: labels.route, statusCode: res.statusCode, durationMs: Math.round(seconds * 1000) }, 'Slow HTTP request');
    }
  };
  res.once('finish', finish);
  res.once('close', finish);
  next();
}

module.exports = { httpMetricsMiddleware, normalizePath, routeLabel };
