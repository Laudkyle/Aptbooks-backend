const router = require('express').Router();
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const { z, validateBody, validateParams } = require('../../../shared/http/requestValidation');
const integrity = require('./financialIntegrity.service');

router.use(authRequired);
const runSchema = z.object({ periodId: z.string().uuid().nullable().optional(), asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), persist: z.boolean().optional() }).strict();
const idSchema = z.object({ id: z.string().uuid() }).strict();

router.post('/run', idempotency({ required: true }), requirePermission('accounting.reconcile.run'), validateBody(runSchema), async (req, res, next) => {
  try {
    const data = await integrity.runIntegrityChecks({ orgId: req.user.organization_id, actorUserId: req.user.id,
      periodId: req.body.periodId || null, asOfDate: req.body.asOfDate, persist: req.body.persist !== false });
    res.json({ data });
  } catch (error) { next(error); }
});
router.get('/latest', requirePermission('accounting.reconcile.run'), async (req, res, next) => {
  try { res.json({ data: await integrity.getLatestRun({ orgId: req.user.organization_id }) }); } catch (error) { next(error); }
});
router.get('/runs/:id', requirePermission('accounting.reconcile.run'), validateParams(idSchema), async (req, res, next) => {
  try { res.json({ data: await integrity.getRun({ orgId: req.user.organization_id, runId: req.params.id }) }); } catch (error) { next(error); }
});

module.exports = router;
