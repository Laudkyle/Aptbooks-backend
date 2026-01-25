const logger = require("../config/logger"); 
const { AppError } = require("../shared/errors/AppError"); 
const { pool } = require("../db/pool"); 

function errorMiddleware(err, req, res, _next) {
  let status = err instanceof AppError ? err.status : 500; 

  // Normalise common framework errors
  if (status === 500 && typeof err?.message === "string" && err.message.toLowerCase().includes("cors")) {
    status = 403; 
  }

  if (status >= 500) {
    logger.error({ err, path: req.path }, "Unhandled error"); 
  }

  // Best-effort persistence for admin error viewer. Never block response.
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
          req.request_id || null,
          req.path,
          req.method,
          status,
          String(err?.message || ""),
          String(err?.stack || ""),
          req.audit?.ip || req.ip || null,
          req.audit?.userAgent || req.headers["user-agent"] || null,
          req.user?.id || null
        ]
      ); 
    } catch (_) {
      // ignore
    }
  })(); 

  // Do not leak internal error details on 5xx.
  const safeMessage = status >= 500 ? "Internal Server Error" : (err.message || "Error"); 
  const details = status >= 500 ? undefined : (err.details || undefined); 

  res.status(status).json({
    error: safeMessage,
    details
  }); 
}

module.exports = { errorMiddleware }; 
