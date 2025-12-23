const logger = require("../config/logger");
const { AppError } = require("../shared/errors/AppError");

function errorMiddleware(err, req, res, _next) {
  const status = err instanceof AppError ? err.status : 500;

  if (status >= 500) {
    logger.error({ err, path: req.path }, "Unhandled error");
  }

  res.status(status).json({
    error: err.message || "Internal Server Error",
    details: err.details || undefined
  });
}

module.exports = { errorMiddleware };
