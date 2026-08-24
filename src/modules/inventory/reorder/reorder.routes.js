const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require('express').Router();
router.use(createModuleBodyContract(['date', 'dueDate', 'filters', 'itemId', 'leadTimeDays', 'lines', 'memo', 'reference', 'reorderPoint', 'reorderQuantity', 'safetyStock', 'warehouseId']));
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const svc = require('./reorder.service');

router.use(authRequired);

router.get('/settings', requirePermission('inventory.reorder.read'), async (req, res, next) => {
  try { res.json(await svc.listSettings({ orgId: req.user.organization_id, query: req.query })); }
  catch (e) { next(e); }
});

router.post('/settings', idempotency({ required: true }), requirePermission('inventory.reorder.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.upsertSetting({ orgId: req.user.organization_id, payload: req.body })); }
  catch (e) { next(e); }
});

router.get('/suggestions', requirePermission('inventory.reorder.read'), async (req, res, next) => {
  try { res.json(await svc.suggestions({ orgId: req.user.organization_id, query: req.query })); }
  catch (e) { next(e); }
});

router.post('/purchase-requisition', idempotency({ required: true }), requirePermission('inventory.reorder.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.createPurchaseRequisitionFromSuggestions({ orgId: req.user.organization_id, actorUserId: req.user.id, payload: req.body })); }
  catch (e) { next(e); }
});

module.exports = router;
