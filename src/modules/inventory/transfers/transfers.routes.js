const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require('express').Router();
router.use(createModuleBodyContract(['comment', 'createdBy', 'destWarehouseId', 'lines', 'memo', 'periodId', 'reference', 'requestDate', 'sourceWarehouseId']));
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const svc = require('./transfers.service');

router.use(authRequired);

router.get('/', requirePermission('inventory.transfers.read'), async (req, res, next) => {
  try { res.json(await svc.listRequests({ orgId: req.user.organization_id, query: req.query })); }
  catch (e) { next(e); }
});

router.get('/:id', requirePermission('inventory.transfers.read'), async (req, res, next) => {
  try { res.json(await svc.getRequest({ orgId: req.user.organization_id, requestId: req.params.id })); }
  catch (e) { next(e); }
});

router.post('/', idempotency({ required: true }), requirePermission('inventory.transfers.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createRequest({ orgId: req.user.organization_id, actorUserId: req.user.id, payload: req.body })); }
  catch (e) { next(e); }
});

router.post('/:id/submit', idempotency({ required: true }), requirePermission('inventory.transfers.manage'), async (req, res, next) => {
  try { res.json(await svc.transition({ orgId: req.user.organization_id, actorUserId: req.user.id, requestId: req.params.id, targetStatus: 'submitted' })); }
  catch (e) { next(e); }
});

router.post('/:id/approve', idempotency({ required: true }), requirePermission('inventory.transfers.approve'), async (req, res, next) => {
  try { res.json(await svc.transition({ orgId: req.user.organization_id, actorUserId: req.user.id, requestId: req.params.id, targetStatus: 'approved' })); }
  catch (e) { next(e); }
});

router.post('/:id/reject', idempotency({ required: true }), requirePermission('inventory.transfers.approve'), async (req, res, next) => {
  try { res.json(await svc.transition({ orgId: req.user.organization_id, actorUserId: req.user.id, requestId: req.params.id, targetStatus: 'rejected', reason: req.body?.comment || null })); }
  catch (e) { next(e); }
});

router.post('/:id/post', idempotency({ required: true }), requirePermission('inventory.transfers.post'), async (req, res, next) => {
  try { res.json(await svc.postRequest({ orgId: req.user.organization_id, actorUserId: req.user.id, requestId: req.params.id })); }
  catch (e) { next(e); }
});

router.post('/:id/cancel', idempotency({ required: true }), requirePermission('inventory.transfers.manage'), async (req, res, next) => {
  try { res.json(await svc.transition({ orgId: req.user.organization_id, actorUserId: req.user.id, requestId: req.params.id, targetStatus: 'cancelled' })); }
  catch (e) { next(e); }
});

module.exports = router;
