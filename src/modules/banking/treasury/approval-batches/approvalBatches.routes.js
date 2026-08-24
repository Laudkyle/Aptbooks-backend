const { createModuleBodyContract } = require("../../../../shared/http/requestValidation");

const express = require('express');
const { authRequired } = require('../../../../middleware/auth.middleware');
const { requirePermission } = require('../../../../middleware/permission.middleware');
const { idempotency } = require('../../../../middleware/idempotency.middleware');
const svc = require('./approvalBatches.service');

const router = express.Router();
router.use(createModuleBodyContract(['approvedByUserId', 'batchNo', 'batch_no', 'cancelledReason', 'items', 'name', 'notes', 'reason', 'scheduledDate', 'scheduled_date']));
router.use(authRequired);

router.get('/', requirePermission('banking.treasury.read'), async (req, res, next) => { try { res.json(await svc.list(req.user.organization_id)); } catch (e) { next(e); } });
router.get('/:batchId', requirePermission('banking.treasury.read'), async (req, res, next) => { try { res.json(await svc.get(req.user.organization_id, req.params.batchId)); } catch (e) { next(e); } });
router.post('/', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => { try { res.status(201).json(await svc.create(req.user.organization_id, req.user.id, req.body)); } catch (e) { next(e); } });
router.post('/:batchId/items', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => { try { res.status(201).json(await svc.addItems(req.user.organization_id, req.params.batchId, req.body)); } catch (e) { next(e); } });
router.post('/:batchId/submit', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => { try { res.json(await svc.submit(req.user.organization_id, req.params.batchId)); } catch (e) { next(e); } });
router.post('/:batchId/approve', idempotency({ required: true }), requirePermission('banking.treasury.approve'), async (req, res, next) => { try { res.json(await svc.approve(req.user.organization_id, req.params.batchId, req.user.id)); } catch (e) { next(e); } });
router.post('/:batchId/cancel', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => { try { res.json(await svc.cancel(req.user.organization_id, req.params.batchId, req.body?.reason)); } catch (e) { next(e); } });

module.exports = router;
