const router = require('express').Router();
const { AppError } = require('../../../shared/errors/AppError');

// These endpoints expose the same global scheduled_tasks control plane as
// /utilities/scheduled-tasks. Tenant RBAC is not an adequate authorization
// boundary for jobs that may iterate across all organizations. The parent
// automation router already requires authentication; all tenant HTTP access is
// denied here until AptBooks has a separately authenticated platform operator.
router.use((_req, _res, next) => {
  next(new AppError(403, 'Accounting job administration is internal-only.'));
});

module.exports = router;
