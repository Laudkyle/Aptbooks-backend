
const router = require('express').Router();
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const { validate } = require('../../../shared/validators/validate');
const svc = require('./documentTemplates.service');
const {
  createTemplateSchema,
  updateTemplateSchema,
  createTemplateVersionSchema,
  upsertAssignmentSchema
} = require('./documentTemplates.validators');

router.use(authRequired);

router.post('/bootstrap-presets', requirePermission('printing.templates.manage'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await svc.ensurePresetLibrary({ orgId, actorUserId });
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/supported-document-types', requirePermission('printing.templates.read'), async (_req, res, next) => {
  try {
    res.json(svc.listSupportedDocumentTypes());
  } catch (e) { next(e); }
});

router.get('/assignments', requirePermission('printing.templates.read'), async (req, res, next) => {
  try {
    res.json(await svc.listAssignments({ orgId: req.user.organization_id }));
  } catch (e) { next(e); }
});

router.post('/assignments', requirePermission('printing.templates.manage'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(upsertAssignmentSchema, req.body);
    res.status(201).json(await svc.upsertAssignment({
      orgId,
      actorUserId,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    }));
  } catch (e) { next(e); }
});

router.get('/', requirePermission('printing.templates.read'), async (req, res, next) => {
  try {
    res.json(await svc.listTemplates({ orgId: req.user.organization_id }));
  } catch (e) { next(e); }
});

router.get('/:id', requirePermission('printing.templates.read'), async (req, res, next) => {
  try {
    res.json(await svc.getTemplate({ orgId: req.user.organization_id, templateId: req.params.id }));
  } catch (e) { next(e); }
});

router.post('/', requirePermission('printing.templates.manage'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createTemplateSchema, req.body);
    res.status(201).json(await svc.createTemplate({
      orgId,
      actorUserId,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    }));
  } catch (e) { next(e); }
});

router.put('/:id', requirePermission('printing.templates.manage'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(updateTemplateSchema, req.body);
    res.json(await svc.updateTemplate({
      orgId,
      actorUserId,
      templateId: req.params.id,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    }));
  } catch (e) { next(e); }
});

router.post('/:id/versions', requirePermission('printing.templates.manage'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createTemplateVersionSchema, req.body);
    res.status(201).json(await svc.createTemplateVersion({
      orgId,
      actorUserId,
      templateId: req.params.id,
      payload,
      audit: { ip: req.audit?.ip, userAgent: req.audit?.userAgent }
    }));
  } catch (e) { next(e); }
});

module.exports = router;
