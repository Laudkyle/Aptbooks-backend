const { createModuleBodyContract } = require("../../../../shared/http/requestValidation");

const express = require('express');
const { authRequired } = require('../../../../middleware/auth.middleware');
const { requirePermission } = require('../../../../middleware/permission.middleware');
const { idempotency } = require('../../../../middleware/idempotency.middleware');
const svc = require('./paymentRuns.service');

const router = express.Router();
router.use(createModuleBodyContract(['approvalBatchId', 'approvedByUserId', 'bankAccountId', 'bank_account_id', 'cancelledReason', 'code', 'currencyCode', 'currency_code', 'executedByUserId', 'executionDate', 'execution_date', 'journalEntryId', 'lines', 'memo', 'periodId', 'reason']));
router.use(authRequired);

router.get('/', requirePermission('banking.treasury.read'), async (req, res, next) => {
  try { res.json(await svc.list(req.user.organization_id, req.query)); } catch (e) { next(e); }
});
router.get('/:paymentRunId', requirePermission('banking.treasury.read'), async (req, res, next) => {
  try { res.json(await svc.get(req.user.organization_id, req.params.paymentRunId)); } catch (e) { next(e); }
});
router.post('/', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.create(req.user.organization_id, req.user.id, req.body)); } catch (e) { next(e); }
});
router.post('/:paymentRunId/lines', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.addLines(req.user.organization_id, req.params.paymentRunId, req.body)); } catch (e) { next(e); }
});
router.post('/:paymentRunId/submit', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => {
  try { res.json(await svc.submit(req.user.organization_id, req.params.paymentRunId)); } catch (e) { next(e); }
});
router.post('/:paymentRunId/approve', idempotency({ required: true }), requirePermission('banking.treasury.approve'), async (req, res, next) => {
  try { res.json(await svc.approve(req.user.organization_id, req.params.paymentRunId, req.user.id)); } catch (e) { next(e); }
});
router.post('/:paymentRunId/execute', idempotency({ required: true }), requirePermission('banking.treasury.execute'), async (req, res, next) => {
  try { res.json(await svc.execute(req.user.organization_id, req.params.paymentRunId, req.user.id)); } catch (e) { next(e); }
});
router.post('/:paymentRunId/cancel', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => {
  try { res.json(await svc.cancel(req.user.organization_id, req.params.paymentRunId, req.body?.reason)); } catch (e) { next(e); }
});

module.exports = router;
