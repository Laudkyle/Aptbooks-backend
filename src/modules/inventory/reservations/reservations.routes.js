const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require('express').Router();
router.use(createModuleBodyContract(['actorUserId', 'expiresAt', 'itemId', 'notes', 'quantity', 'reference', 'reservedForId', 'reservedForType', 'sourceDocumentId', 'warehouseId']));
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const svc = require('./reservations.service');

router.use(authRequired);

router.get('/', requirePermission('inventory.reservations.read'), async (req, res, next) => {
  try { res.json(await svc.listReservations({ orgId: req.user.organization_id, query: req.query })); }
  catch (e) { next(e); }
});

router.get('/availability', requirePermission('inventory.reservations.read'), async (req, res, next) => {
  try {
    res.json(await svc.getAvailability({ orgId: req.user.organization_id, warehouseId: req.query.warehouseId, itemId: req.query.itemId }));
  } catch (e) { next(e); }
});

router.post('/', idempotency({ required: true }), requirePermission('inventory.reservations.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createReservation({ orgId: req.user.organization_id, actorUserId: req.user.id, payload: req.body })); }
  catch (e) { next(e); }
});

router.post('/:id/release', idempotency({ required: true }), requirePermission('inventory.reservations.manage'), async (req, res, next) => {
  try { res.json(await svc.releaseReservation({ orgId: req.user.organization_id, actorUserId: req.user.id, reservationId: req.params.id, mode: 'released' })); }
  catch (e) { next(e); }
});

router.post('/:id/fulfill', idempotency({ required: true }), requirePermission('inventory.reservations.manage'), async (req, res, next) => {
  try { res.json(await svc.releaseReservation({ orgId: req.user.organization_id, actorUserId: req.user.id, reservationId: req.params.id, mode: 'fulfilled' })); }
  catch (e) { next(e); }
});

module.exports = router;
