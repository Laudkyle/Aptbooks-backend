const router = require('express').Router();
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const { z, validateBody } = require('../../../shared/http/requestValidation');
const policy = require('./accountingPolicy.service');

router.use(authRequired);
const versionSchema = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  moneyScale: z.literal(2).optional(),
  exchangeRateScale: z.literal(6).optional(),
  inventoryValueScale: z.literal(6).optional(),
  roundingMode: z.literal('HALF_UP').optional(),
  taxRoundingScope: z.literal('LINE').optional(),
  postingDatePolicy: z.literal('DOCUMENT_DATE').optional(),
  closedPeriodAdjustmentPolicy: z.literal('REJECT').optional(),
  reversalPolicy: z.literal('EXPLICIT_REVERSAL').optional(),
}).strict();

router.get('/effective', requirePermission('accounting.reconcile.run'), async (req, res, next) => {
  try { res.json({ data: await policy.getEffectivePolicy({ orgId: req.user.organization_id, asOfDate: req.query.asOfDate, actorUserId: req.user.id }) }); }
  catch (error) { next(error); }
});
router.get('/versions', requirePermission('accounting.reconcile.run'), async (req, res, next) => {
  try { res.json({ data: await policy.listPolicyVersions({ orgId: req.user.organization_id }) }); } catch (error) { next(error); }
});
router.post('/versions', idempotency({ required: true }), requirePermission('settings.manage'), validateBody(versionSchema), async (req, res, next) => {
  try { res.status(201).json({ data: await policy.createPolicyVersion({ orgId: req.user.organization_id, actorUserId: req.user.id, payload: req.body }) }); }
  catch (error) { next(error); }
});

module.exports = router;
