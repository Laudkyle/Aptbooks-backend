const router = require('express').Router();
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const svc = require('./recurringTransactions.service');

router.get('/', requirePermission('automation.recurring.read'), async (req, res, next) => {
  try { res.json(await svc.list(req.user.organization_id)); } catch (e) { next(e); }
});
router.post('/', idempotency({ required: true }), requirePermission('automation.recurring.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.create(req.user.organization_id, req.user.id, req.body)); } catch (e) { next(e); }
});
router.get('/:id', requirePermission('automation.recurring.read'), async (req, res, next) => {
  try { res.json(await svc.getOne(req.user.organization_id, req.params.id)); } catch (e) { next(e); }
});
router.put('/:id', idempotency({ required: true }), requirePermission('automation.recurring.manage'), async (req, res, next) => {
  try { res.json(await svc.update(req.user.organization_id, req.params.id, req.user.id, req.body)); } catch (e) { next(e); }
});
router.post('/:id/run', idempotency({ required: true }), requirePermission('automation.recurring.run'), async (req, res, next) => {
  try { res.json(await svc.runNow(req.user.organization_id, req.user.id, req.params.id, req.body)); } catch (e) { next(e); }
});
router.get('/:id/runs', requirePermission('automation.recurring.read'), async (req, res, next) => {
  try { res.json(await svc.listRuns(req.user.organization_id, req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
