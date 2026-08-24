const logger = require('../config/logger');

let draining = false;
let activeRequests = 0;
let drainResolvers = [];

function isDraining() { return draining; }

function requestDrainMiddleware(req, res, next) {
  if (draining) {
    res.setHeader('Connection', 'close');
    return res.status(503).json({ ok: false, error: { code: 'service_draining', message: 'Service is restarting. Please retry.' }, requestId: req.request_id || null });
  }
  activeRequests += 1;
  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    activeRequests = Math.max(0, activeRequests - 1);
    if (activeRequests === 0) {
      const resolvers = drainResolvers;
      drainResolvers = [];
      resolvers.forEach((resolve) => resolve());
    }
  };
  res.once('finish', finish);
  res.once('close', finish);
  next();
}

function beginDrain() { draining = true; }

async function waitForDrain(timeoutMs) {
  if (activeRequests === 0) return true;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    drainResolvers.push(() => done(true));
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
  });
}

function installGracefulShutdown({ server, stopScheduler = null, pool = null, timeoutMs = 30000 } = {}) {
  if (!server || typeof server.close !== 'function') throw new Error('installGracefulShutdown requires the Node HTTP server');
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    beginDrain();
    logger.warn({ signal, activeRequests }, 'Graceful shutdown started');
    server.close();
    const drained = await waitForDrain(timeoutMs);
    try { if (typeof stopScheduler === 'function') await stopScheduler(); } catch (error) { logger.error({ error }, 'Scheduler shutdown failed'); }
    try { if (pool?.end) await pool.end(); } catch (error) { logger.error({ error }, 'Database pool shutdown failed'); }
    logger.warn({ signal, drained, activeRequests }, 'Graceful shutdown completed');
    process.exitCode = drained ? 0 : 1;
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  return { shutdown };
}

module.exports = { requestDrainMiddleware, installGracefulShutdown, beginDrain, isDraining, waitForDrain };
