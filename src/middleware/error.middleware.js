const logger = require("../config/logger");
const { pool } = require("../db/pool");
const { normalizeError } = require("../shared/errors/normalizeError");

function errorMiddleware(err, req, res, _next) {
  const normalized = normalizeError(err, req);

  if (normalized.status >= 500) {
    logger.error({ err, path: req.path, requestId: normalized.requestId }, "Unhandled error");
  } else {
    logger.warn({
      code: normalized.code,
      message: normalized.originalMessage || normalized.message,
      path: req.path,
      requestId: normalized.requestId,
    traceId: req.trace?.traceId || null
    }, "Handled request error");
  }

  (async () => {
    try {
      await pool.query(
        `
        INSERT INTO error_logs(
          organization_id, correlation_id, path, method, status,
          message, stack, ip, user_agent, user_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [
          req.user?.organization_id || null,
          normalized.requestId,
          req.path,
          req.method,
          normalized.status,
          normalized.originalMessage || normalized.message,
          normalized.status >= 500 ? String(normalized.stack || "") : String(err?.stack || ""),
          req.audit?.ip || req.ip || null,
          req.audit?.userAgent || req.headers["user-agent"] || null,
          req.user?.id || null
        ]
      );
    } catch (_) {
      // ignore logging failures
    }
  })();

  const errorPayload = {
    code: normalized.code,
    message: normalized.message,
    details: normalized.details,
    requestId: normalized.requestId,
    traceId: req.trace?.traceId || null
  };

  // Canonical error envelope. Legacy top-level fields are retained during the
  // migration window so existing clients do not break abruptly.
  res.status(normalized.status).json({
    ok: false,
    error: errorPayload,
    code: errorPayload.code,
    message: errorPayload.message,
    details: errorPayload.details,
    requestId: errorPayload.requestId,
    traceId: errorPayload.traceId
  });
}

module.exports = { errorMiddleware };
