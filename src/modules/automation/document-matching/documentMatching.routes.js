const router = require('express').Router();
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const svc = require('./documentMatching.service');

router.get('/profiles', requirePermission('automation.document-matching.read'), async (req, res, next) => {
  try { res.json(await svc.listProfiles(req.user.organization_id)); } catch (e) { next(e); }
});
router.post('/profiles', idempotency({ required: true }), requirePermission('automation.document-matching.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createProfile(req.user.organization_id, req.user.id, req.body)); } catch (e) { next(e); }
});
router.get('/profiles/:id', requirePermission('automation.document-matching.read'), async (req, res, next) => {
  try { res.json(await svc.getProfile(req.user.organization_id, req.params.id)); } catch (e) { next(e); }
});
router.put('/profiles/:id', idempotency({ required: true }), requirePermission('automation.document-matching.manage'), async (req, res, next) => {
  try { res.json(await svc.updateProfile(req.user.organization_id, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/profiles/:id/run', idempotency({ required: true }), requirePermission('automation.document-matching.run'), async (req, res, next) => {
  try { res.json(await svc.runProfile(req.user.organization_id, req.params.id)); } catch (e) { next(e); }
});
router.get('/profiles/:id/runs', requirePermission('automation.document-matching.read'), async (req, res, next) => {
  try { res.json(await svc.listRuns(req.user.organization_id, req.params.id)); } catch (e) { next(e); }
});
router.get('/runs/:runId/results', requirePermission('automation.document-matching.read'), async (req, res, next) => {
  try { res.json(await svc.listResults(req.user.organization_id, req.params.runId)); } catch (e) { next(e); }
});

module.exports = router;
