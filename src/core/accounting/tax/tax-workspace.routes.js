const express = require('express');

const { AppError } = require('../../../shared/errors/AppError');
const { requireAnyPermission } = require('../../../middleware/permission.middleware');
const workspaceSvc = require('./taxWorkspace.service');

const router = express.Router();

function getOrganizationId(req) {
  const orgId = req.user?.organization_id || req.user?.organizationId || req.user?.org_id || req.user?.orgId || null;
  if (!orgId) throw new AppError(401, 'Authenticated user is missing organization context');
  return orgId;
}

router.get('/workspace', requireAnyPermission(['tax.read', 'tax.ghana.readiness.read']), async (req, res, next) => {
  try {
    const data = await workspaceSvc.getWorkspaceSummary({ orgId: getOrganizationId(req) });
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
