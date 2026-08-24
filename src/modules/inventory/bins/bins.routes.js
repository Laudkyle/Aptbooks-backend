const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require('express').Router();
router.use(createModuleBodyContract(['code', 'isDefault', 'name', 'status', 'warehouseId']));
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const svc = require('./bins.service');

router.use(authRequired);

router.get('/', requirePermission('inventory.warehouses.read'), async (req, res, next) => {
  try { res.json(await svc.listBins(req.user.organization_id, req.query)); }
  catch (e) { next(e); }
});

router.post('/', idempotency({ required: true }), requirePermission('inventory.warehouses.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createBin(req.user.organization_id, req.body)); }
  catch (e) { next(e); }
});

router.patch('/:id', idempotency({ required: true }), requirePermission('inventory.warehouses.manage'), async (req, res, next) => {
  try { res.json(await svc.updateBin(req.user.organization_id, req.params.id, req.body)); }
  catch (e) { next(e); }
});

module.exports = router;
