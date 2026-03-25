const router = require('express').Router();
const { requirePermission } = require('../../../middleware/permission.middleware');
const svc = require('./taxAutomation.service');

router.get('/dashboard', requirePermission('automation.jobs.read'), async (req, res, next) => {
  try { res.json({ data: await svc.dashboard({ orgId: req.user.organization_id }) }); } catch (e) { next(e); }
});

router.get('/advisor', requirePermission('automation.jobs.read'), async (req, res, next) => {
  try { res.json({ data: await svc.runAdvisor({ orgId: req.user.organization_id }) }); } catch (e) { next(e); }
});

router.post('/rules', requirePermission('automation.jobs.manage'), async (req, res, next) => {
  try { res.status(201).json({ data: await svc.upsertRule({ orgId: req.user.organization_id, payload: req.body || {} }) }); } catch (e) { next(e); }
});

module.exports = router;
