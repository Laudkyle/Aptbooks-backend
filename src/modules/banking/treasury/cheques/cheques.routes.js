const { createModuleBodyContract } = require("../../../../shared/http/requestValidation");

const express = require('express');
const { authRequired } = require('../../../../middleware/auth.middleware');
const { requirePermission } = require('../../../../middleware/permission.middleware');
const { idempotency } = require('../../../../middleware/idempotency.middleware');
const svc = require('./cheques.service');

const router = express.Router();
router.use(createModuleBodyContract(['amount', 'bankAccountId', 'bank_account_id', 'chequeNo', 'cheque_no', 'clearedDate', 'cleared_date', 'currencyCode', 'currency_code', 'dimensionsJson', 'dimensions_json', 'issueDate', 'issue_date', 'journalEntryId', 'journal_entry_id', 'memo', 'offsetAccountId', 'offset_account_id', 'payeeName', 'payee_name', 'paymentRunId', 'payment_run_id', 'postOnIssue', 'post_on_issue', 'status']));
router.use(authRequired);
router.get('/', requirePermission('banking.treasury.read'), async (req, res, next) => { try { res.json(await svc.list(req.user.organization_id, req.query)); } catch (e) { next(e); } });
router.get('/:chequeId', requirePermission('banking.treasury.read'), async (req, res, next) => { try { res.json(await svc.get(req.user.organization_id, req.params.chequeId)); } catch (e) { next(e); } });
router.post('/', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => { try { res.status(201).json(await svc.createLeaf(req.user.organization_id, req.user.id, req.body)); } catch (e) { next(e); } });
router.post('/:chequeId/issue', idempotency({ required: true }), requirePermission('banking.treasury.execute'), async (req, res, next) => { try { res.json(await svc.issue(req.user.organization_id, req.params.chequeId, req.user.id, req.body || {})); } catch (e) { next(e); } });
router.post('/:chequeId/clear', idempotency({ required: true }), requirePermission('banking.treasury.execute'), async (req, res, next) => { try { res.json(await svc.clear(req.user.organization_id, req.params.chequeId, req.body || {})); } catch (e) { next(e); } });
router.post('/:chequeId/void', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => { try { res.json(await svc.voidCheque(req.user.organization_id, req.params.chequeId, req.body || {})); } catch (e) { next(e); } });
router.post('/:chequeId/bounce', idempotency({ required: true }), requirePermission('banking.treasury.manage'), async (req, res, next) => { try { res.json(await svc.bounce(req.user.organization_id, req.params.chequeId, req.body || {})); } catch (e) { next(e); } });

module.exports = router;
