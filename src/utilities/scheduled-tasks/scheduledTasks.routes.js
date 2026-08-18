const router = require("express").Router();
const { authRequired } = require("../../middleware/auth.middleware");
const { AppError } = require("../../shared/errors/AppError");

router.use(authRequired);

// The persisted scheduled_tasks registry contains global financial jobs whose
// handlers may iterate every organization. AptBooks currently has tenant users
// and non-login system actors, but no separately authenticated platform-operator
// principal. Exposing this registry through tenant RBAC (e.g. settings.manage)
// would therefore cross the platform/tenant control-plane boundary.
//
// Scheduler execution remains active through the internal scheduler process.
// Reintroduce HTTP administration only alongside a real platform-operator auth
// boundary; do not gate global jobs with tenant role permissions.
router.use((_req, _res, next) => {
  next(new AppError(403, "Scheduled-task administration is internal-only."));
});

module.exports = router;
