const { AppError } = require('../shared/errors/AppError');

function rejectTenantSpoofing(req, _res, next) {
  const supplied = req.headers['x-organization-id'] || req.headers['x-tenant-id'];
  if (supplied) {
    return next(new AppError(400, 'Tenant context cannot be supplied by the client', undefined, 'client_tenant_context_forbidden'));
  }
  return next();
}

module.exports = { rejectTenantSpoofing };
