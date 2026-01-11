const { env } = require("../config/env");

// Simple in-memory rate limiter with a fixed window per key.
// NOTE: This is NOT horizontally scalable. For production multi-instance,
// back this with a shared store (e.g., Redis) using the same interface.
function createRateLimiter({ windowMs, max, keyFn, skipFn } = {}) {
  const store = new Map(); // key -> { resetAt, count }
  const WINDOW = windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const MAX = max ?? env.RATE_LIMIT_MAX;

  function cleanup(now) {
    // Opportunistic cleanup
    if (store.size < 1000) return;
    for (const [k, v] of store.entries()) {
      if (v.resetAt <= now) store.delete(k);
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    try {
      if (skipFn && skipFn(req)) return next();

      const now = Date.now();
      cleanup(now);

      const key = keyFn ? keyFn(req) : (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");
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
