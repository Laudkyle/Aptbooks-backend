const { AppError } = require('../shared/errors/AppError');

function notFoundMiddleware(req, _res, next) {
  next(new AppError(404, 'The requested endpoint could not be found.', {
    path: req.originalUrl,
    method: req.method
  }, 'route_not_found'));
}

module.exports = { notFoundMiddleware };
