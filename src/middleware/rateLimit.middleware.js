const crypto = require('crypto');
const { env } = require('../config/env');
const { pool } = require('../db/pool');
const logger = require('../config/logger');
const { AppError } = require('../shared/errors/AppError');

function hashKeyPart(value) {
  return crypto.createHash('sha256').update(String(value || '').toLowerCase()).digest('hex').slice(0, 24);
}

function createRateLimiter({ windowMs, max, keyFn, skipFn, failClosed } = {}) {
  const storeMode = env.RATE_LIMIT_STORE;
  const store = new Map();
  const WINDOW = windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const MAX = max ?? env.RATE_LIMIT_MAX;
  const FAIL_CLOSED = failClosed ?? env.RATE_LIMIT_FAIL_CLOSED;

  async function hitPostgres(key, nowMs) {
    const windowStartMs = Math.floor(nowMs / WINDOW) * WINDOW;
    const resetAtMs = windowStartMs + WINDOW;
    const { rows } = await pool.query(
      `INSERT INTO rate_limit_windows (key, window_start, reset_at, count)
       VALUES ($1, $2::timestamptz, $3::timestamptz, 1)
       ON CONFLICT (key, window_start)
       DO UPDATE SET count = rate_limit_windows.count + 1
       RETURNING count, EXTRACT(EPOCH FROM reset_at)::bigint AS reset_epoch`,
      [key, new Date(windowStartMs).toISOString(), new Date(resetAtMs).toISOString()]
    );
    return {
      count: Number(rows?.[0]?.count || 1),
      resetEpoch: Number(rows?.[0]?.reset_epoch || Math.ceil(resetAtMs / 1000)),
    };
  }

  function hitMemory(key, nowMs) {
    const current = store.get(key);
    if (!current || current.resetAt <= nowMs) {
      const fresh = { resetAt: nowMs + WINDOW, count: 1 };
      store.set(key, fresh);
      return { count: 1, resetEpoch: Math.ceil(fresh.resetAt / 1000) };
    }
    current.count += 1;
    if (store.size > 5000) {
      for (const [entryKey, value] of store.entries()) if (value.resetAt <= nowMs) store.delete(entryKey);
    }
    return { count: current.count, resetEpoch: Math.ceil(current.resetAt / 1000) };
  }

  return async function rateLimitMiddleware(req, res, next) {
    try {
      if (skipFn?.(req)) return next();
      const key = keyFn ? keyFn(req) : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
      const hit = storeMode === 'postgres' ? await hitPostgres(key, Date.now()) : hitMemory(key, Date.now());
      const remaining = Math.max(0, MAX - hit.count);
      res.setHeader('x-ratelimit-limit', String(MAX));
      res.setHeader('x-ratelimit-remaining', String(remaining));
      res.setHeader('x-ratelimit-reset', String(hit.resetEpoch));
      if (hit.count > MAX) {
        return next(new AppError(429, 'Too many requests. Please wait and try again.', {
          retryAfterEpoch: hit.resetEpoch,
        }, 'rate_limit_exceeded'));
      }
      return next();
    } catch (error) {
      if (FAIL_CLOSED) {
        logger.error({ err: error?.message }, 'Rate limiter unavailable; failing closed');
        return next(new AppError(503, 'Request protection is temporarily unavailable. Please try again.', undefined, 'rate_limiter_unavailable'));
      }
      logger.warn({ err: error?.message }, 'Rate limiter unavailable; failing open outside strict mode');
      return next();
    }
  };
}

const ipKey = (prefix) => (req) => `${prefix}:ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;

const globalRateLimit = createRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  keyFn: ipKey('global'),
  skipFn: (req) => req.path === '/healthz' || req.path === '/readyz' || req.path === env.METRICS_PATH,
  failClosed: false,
});

const authRateLimit = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  keyFn: ipKey('auth'),
  failClosed: env.NODE_ENV === 'production',
});

const loginRateLimit = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  max: env.LOGIN_RATE_LIMIT_MAX,
  keyFn: (req) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const emailHash = hashKeyPart(req.body?.email || 'unknown');
    return `login:${ip}:${emailHash}`;
  },
  failClosed: true,
});

const passwordResetRateLimit = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  max: env.PASSWORD_RESET_RATE_LIMIT_MAX,
  keyFn: (req) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const emailHash = hashKeyPart(req.body?.email || req.body?.token || 'unknown');
    return `password-reset:${ip}:${emailHash}`;
  },
  failClosed: true,
});

module.exports = {
  createRateLimiter,
  globalRateLimit,
  authRateLimit,
  loginRateLimit,
  passwordResetRateLimit,
};
