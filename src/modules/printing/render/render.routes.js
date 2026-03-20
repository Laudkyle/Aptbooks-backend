
const router = require('express').Router();
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const renderSvc = require('./render.service');

router.use(authRequired);

router.get('/sample/:entityType', requirePermission('printing.render'), async (req, res, next) => {
  try {
    const out = await renderSvc.previewSample({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      entityType: req.params.entityType,
      templateId: req.query.templateId || null
    });
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/:entityType/:documentId', requirePermission('printing.render'), async (req, res, next) => {
  try {
    const out = await renderSvc.renderDocument({
      orgId: req.user.organization_id,
      actorUserId: req.user.id,
      entityType: req.params.entityType,
      documentId: req.params.documentId,
      templateId: req.query.templateId || null,
      mode: String(req.query.mode || 'preview')
    });
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
