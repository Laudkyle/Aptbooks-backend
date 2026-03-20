const router = require('express').Router();
const { requirePermission } = require('../../../middleware/permission.middleware');
const svc = require('./accountingJobs.service');

router.get('/', requirePermission('automation.jobs.read'), async (req, res, next) => {
  try { res.json(await svc.listTasks()); } catch (e) { next(e); }
});
router.get('/:code/runs', requirePermission('automation.jobs.read'), async (req, res, next) => {
  try { res.json(await svc.listRuns(req.params.code, req.query.limit)); } catch (e) { next(e); }
});
router.post('/:code/run', requirePermission('automation.jobs.run'), async (req, res, next) => {
  try { res.json(await svc.runNow(req.params.code, req.user.id)); } catch (e) { next(e); }
});
router.post('/:code/toggle', requirePermission('automation.jobs.manage'), async (req, res, next) => {
  try { res.json(await svc.toggle(req.params.code, req.body?.isEnabled)); } catch (e) { next(e); }
});

module.exports = router;
