const { createModuleBodyContract } = require("../../../../shared/http/requestValidation");

const express = require('express');
const { authRequired } = require('../../../../middleware/auth.middleware');
const { requirePermission } = require('../../../../middleware/permission.middleware');
const { idempotency } = require('../../../../middleware/idempotency.middleware');
const svc = require('./bankTransfers.service');

const router = express.Router();
router.use(createModuleBodyContract(['amount', 'approvalBatchId', 'approvedByUserId', 'cancelledReason', 'code', 'feeAccountId', 'feeAmount', 'fee_account_id', 'fee_amount', 'fromBankAccountId', 'from_bank_account_id', 'journalEntryId', 'memo', 'periodId', 'postedByUserId', 'reason', 'reference', 'toBankAccountId', 'to_bank_account_id', 'transferDate', 'transfer_date']));
router.use(authRequired);

router.get('/', requirePermission('banking.treasury.read'), async (req, res, next) => {
  try { res.json(await svc.list(req.user.organization_id, req.query)); } catch (e) { next(e); }
});
router.get('/:bankTransferId', requirePermission('banking.treasury.read'), async (req, res, next) => {
  try { res.json(await svc.get(req.user.organization_id, req.params.bankTransferId)); } catch (e) { next(e); }
});
router.post('/', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => {
  try { res.status(201).json(await svc.create(req.user.organization_id, req.user.id, req.body)); } catch (e) { next(e); }
});
router.post('/:bankTransferId/submit', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => {
  try { res.json(await svc.submit(req.user.organization_id, req.params.bankTransferId)); } catch (e) { next(e); }
});
router.post('/:bankTransferId/approve', idempotency({ required: true }), requirePermission('banking.treasury.approve'), async (req, res, next) => {
  try { res.json(await svc.approve(req.user.organization_id, req.params.bankTransferId, req.user.id)); } catch (e) { next(e); }
});
router.post('/:bankTransferId/post', idempotency({ required: true }), requirePermission('banking.treasury.execute'), async (req, res, next) => {
  try { res.json(await svc.post(req.user.organization_id, req.params.bankTransferId, req.user.id)); } catch (e) { next(e); }
});
router.post('/:bankTransferId/cancel', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => {
  try { res.json(await svc.cancel(req.user.organization_id, req.params.bankTransferId, req.body?.reason)); } catch (e) { next(e); }
});

module.exports = router;
