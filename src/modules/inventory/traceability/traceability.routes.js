const router = require('express').Router();
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const { idempotency } = require('../../../middleware/idempotency.middleware');
const svc = require('./traceability.service');

router.use(authRequired);

router.get('/batches', requirePermission('inventory.traceability.read'), async (req, res, next) => {
  try { res.json(await svc.listBatches({ orgId: req.user.organization_id, query: req.query })); }
  catch (e) { next(e); }
});

router.get('/serials', requirePermission('inventory.traceability.read'), async (req, res, next) => {
  try { res.json(await svc.listSerials({ orgId: req.user.organization_id, query: req.query })); }
  catch (e) { next(e); }
});

router.post('/batches/receive', idempotency({ required: true }), requirePermission('inventory.traceability.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.receiveBatches({ orgId: req.user.organization_id, transactionId: req.body.transactionId, lineId: req.body.lineId, batches: req.body.batches })); }
  catch (e) { next(e); }
});

router.post('/batches/issue', idempotency({ required: true }), requirePermission('inventory.traceability.manage'), async (req, res, next) => {
  try { res.json(await svc.issueBatches({ orgId: req.user.organization_id, transactionId: req.body.transactionId, lineId: req.body.lineId, allocations: req.body.allocations })); }
  catch (e) { next(e); }
});

router.post('/serials/receive', idempotency({ required: true }), requirePermission('inventory.traceability.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.receiveSerials({ orgId: req.user.organization_id, transactionId: req.body.transactionId, lineId: req.body.lineId, serialNumbers: req.body.serialNumbers, batchId: req.body.batchId || null })); }
  catch (e) { next(e); }
});

router.post('/serials/issue', idempotency({ required: true }), requirePermission('inventory.traceability.manage'), async (req, res, next) => {
  try { res.json(await svc.issueSerials({ orgId: req.user.organization_id, transactionId: req.body.transactionId, lineId: req.body.lineId, serialIds: req.body.serialIds })); }
  catch (e) { next(e); }
});

module.exports = router;
