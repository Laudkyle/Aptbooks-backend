const router = require('express').Router();
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const svc = require('./aiClassification.service');

router.get('/rules', requirePermission('automation.classification.read'), async (req, res, next) => {
  try { res.json(await svc.listRules(req.user.organization_id)); } catch (e) { next(e); }
});
router.post('/rules', idempotency({ required: true }), requirePermission('automation.classification.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createRule(req.user.organization_id, req.user.id, req.body)); } catch (e) { next(e); }
});
router.put('/rules/:id', idempotency({ required: true }), requirePermission('automation.classification.manage'), async (req, res, next) => {
  try { res.json(await svc.updateRule(req.user.organization_id, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/classify', requirePermission('automation.classification.run'), async (req, res, next) => {
  try { res.json(await svc.classify(req.user.organization_id, req.body)); } catch (e) { next(e); }
});
router.get('/logs', requirePermission('automation.classification.read'), async (req, res, next) => {
  try { res.json(await svc.listLogs(req.user.organization_id, req.query.limit)); } catch (e) { next(e); }
});

module.exports = router;
