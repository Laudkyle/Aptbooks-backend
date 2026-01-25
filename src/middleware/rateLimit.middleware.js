const { env } = require("../config/env");
const { pool } = require("../db/pool");
const logger = require("../config/logger");

// Simple in-memory rate limiter with a fixed window per key.
// NOTE: This is NOT horizontally scalable. For production multi-instance,
// back this with a shared store (e.g., Redis) using the same interface.
function createRateLimiter({ windowMs, max, keyFn, skipFn } = {}) {
  // In production with multiple instances, the in-memory store will not be consistent.
  // Support a Postgres-backed store to keep behaviour deterministic across replicas.
  const storeMode = (env.RATE_LIMIT_STORE || "memory").toLowerCase();

  const store = new Map();// key -> { resetAt, count }
  const WINDOW = windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const MAX = max ?? env.RATE_LIMIT_MAX;

  async function hitPostgres(key, nowMs) {
    // Fixed window keyed by UTC epoch window start.
    const windowStartMs = Math.floor(nowMs / WINDOW) * WINDOW;
    const resetAtMs = windowStartMs + WINDOW;
    const windowStartIso = new Date(windowStartMs).toISOString();
    const resetAtIso = new Date(resetAtMs).toISOString();

    // Upsert counter. Requires migration 059_rate_limit_windows.sql.
    const q = `
      INSERT INTO rate_limit_windows (key, window_start, reset_at, count)
      VALUES ($1, $2::timestamptz, $3::timestamptz, 1)
      ON CONFLICT (key, window_start)
      DO UPDATE SET count = rate_limit_windows.count + 1
      RETURNING count, EXTRACT(EPOCH FROM reset_at)::bigint AS reset_epoch
    `;
    const { rows } = await pool.query(q, [key, windowStartIso, resetAtIso]);
    const count = Number(rows?.[0]?.count || 1);
    const resetEpoch = Number(rows?.[0]?.reset_epoch || Math.ceil(resetAtMs / 1000));
    return { count, resetEpoch };
  }

  function cleanup(now) {
    // Opportunistic cleanup
    if (store.size < 1000) return;
    for (const [k, v] of store.entries()) {
      if (v.resetAt <= now) store.delete(k);
    }
  }

  return async function rateLimitMiddleware(req, res, next) {
    try {
      if (skipFn && skipFn(req)) return next();

      const now = Date.now();
      cleanup(now);

      const key = keyFn ? keyFn(req) : (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");

      // Postgres mode (shared across instances)
      if (storeMode === "postgres") {
        const { count, resetEpoch } = await hitPostgres(key, now);
        const remaining = Math.max(0, MAX - count);

        res.setHeader("x-ratelimit-limit", String(MAX));
        res.setHeader("x-ratelimit-remaining", String(remaining));
        res.setHeader("x-ratelimit-reset", String(resetEpoch));

        if (count > MAX) {
          res.status(429).json({
            error: "Too Many Requests",
            message: "Rate limit exceeded. Please try again later."
          });
          return;
        }
        return next();
      }
      const current = store.get(key);

      if (!current || current.resetAt <= now) {
        store.set(key, { resetAt: now + WINDOW, count: 1 });
        res.setHeader("x-ratelimit-limit", String(MAX));
        res.setHeader("x-ratelimit-remaining", String(Math.max(0, MAX - 1)));
        res.setHeader("x-ratelimit-reset", String(Math.ceil((now + WINDOW) / 1000)));
        return next();
      }

      current.count += 1;

      const remaining = Math.max(0, MAX - current.count);
      res.setHeader("x-ratelimit-limit", String(MAX));
      res.setHeader("x-ratelimit-remaining", String(remaining));
      res.setHeader("x-ratelimit-reset", String(Math.ceil(current.resetAt / 1000)));

      if (current.count > MAX) {
        res.status(429).json({
          error: "Too Many Requests",
          message: "Rate limit exceeded. Please try again later."
        });
        return;
      }

      next();
    } catch (err) {
      // Fail-open to avoid taking the API down due to limiter errors.
      logger.warn({ err: err?.message }, "Rate limiter failed open");
      next();
    }
  };
}

// Default global limiter (per IP)
const globalRateLimit = createRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  keyFn: (req) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    return `ip:${ip}`;
  },
  // Skip Swagger assets if desired
  skipFn: (req) => req.path.startsWith("/docs")
});

// Stricter limiter for auth endpoints (per IP)
const authRateLimit = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  keyFn: (req) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    return `auth:${ip}`;
  }
});

module.exports = { createRateLimiter, globalRateLimit, authRateLimit };
