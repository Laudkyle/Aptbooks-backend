const logger = require("../config/logger");
const { AppError } = require("../shared/errors/AppError");

function errorMiddleware(err, req, res, _next) {
  let status = err instanceof AppError ? err.status : 500;

  // Normalise common framework errors
  if (status === 500 && typeof err?.message === "string" && err.message.toLowerCase().includes("cors")) {
    status = 403;
  }

  if (status >= 500) {
    logger.error({ err, path: req.path }, "Unhandled error");
  }

  // Do not leak internal error details on 5xx.
  const safeMessage = status >= 500 ? "Internal Server Error" : (err.message || "Error");
  const details = status >= 500 ? undefined : (err.details || undefined);

  res.status(status).json({
    error: safeMessage,
    details
  });
}

module.exports = { errorMiddleware };
