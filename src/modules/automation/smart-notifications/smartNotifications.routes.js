const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require('express').Router();
router.use(createModuleBodyContract(['code', 'config', 'isEnabled', 'name', 'severity', 'targetUserId', 'triggerType', 'trigger_type']));
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const svc = require('./smartNotifications.service');

router.get('/rules', requirePermission('automation.notifications.read'), async (req, res, next) => {
  try { res.json(await svc.listRules(req.user.organization_id)); } catch (e) { next(e); }
});
router.post('/rules', idempotency({ required: true }), requirePermission('automation.notifications.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createRule(req.user.organization_id, req.user.id, req.body)); } catch (e) { next(e); }
});
router.put('/rules/:id', idempotency({ required: true }), requirePermission('automation.notifications.manage'), async (req, res, next) => {
  try { res.json(await svc.updateRule(req.user.organization_id, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/rules/:id/run', idempotency({ required: true }), requirePermission('automation.notifications.run'), async (req, res, next) => {
  try { res.json(await svc.executeRule(req.user.organization_id, req.user.id, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
