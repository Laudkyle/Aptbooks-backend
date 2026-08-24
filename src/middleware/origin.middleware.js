const { env } = require('../config/env');
const { AppError } = require('../shared/errors/AppError');

function originRequiredForCredentialCookie(req, _res, next) {
  if (!env.REFRESH_TOKEN_USE_COOKIE) return next();
  const origin = req.headers.origin;
  if (!origin) {
    // Non-browser clients do not normally send Origin. In production cookie mode,
    // refresh/logout are browser credential endpoints, so fail closed.
    if (env.NODE_ENV === 'production') return next(new AppError(403, 'Origin header required', undefined, 'origin_required'));
    return next();
  }
  if (!env.CORS_ALLOWED_ORIGINS.includes(origin)) {
    return next(new AppError(403, 'Origin not allowed', { origin }, 'origin_not_allowed'));
  }
  return next();
}

module.exports = { originRequiredForCredentialCookie };
