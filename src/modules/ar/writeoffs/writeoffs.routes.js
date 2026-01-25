const express = require('express');
const { requirePermission } = require('../../../middleware/permission.middleware');
const svc = require('./writeoffs.service');

const router = express.Router();

// Reason codes
router.get('/reason-codes', requirePermission('writeoffs.read'), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listReasonCodes({ orgId }) });
  } catch (e) { next(e);}
});

router.post('/reason-codes', requirePermission('writeoffs.manage'), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.status(201).json({ data: await svc.upsertReasonCode({ orgId, payload: req.body }) });
  } catch (e) { next(e);}
});

router.delete('/reason-codes/:code', requirePermission('writeoffs.manage'), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.deleteReasonCode({ orgId, code: req.params.code }) });
  } catch (e) { next(e);}
});

// Settings
router.get('/settings', requirePermission('writeoffs.read'), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.getSettings({ orgId }) });
  } catch (e) { next(e);}
});

router.put('/settings', requirePermission('writeoffs.manage'), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.upsertSettings({ orgId, payload: req.body }) });
  } catch (e) { next(e);}
});

// Write-offs
router.get('/', requirePermission('writeoffs.read'), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { status } = req.query;
    res.json({ data: await svc.listWriteoffs({ orgId, status }) });
  } catch (e) { next(e);}
});

router.get('/:id', requirePermission('writeoffs.read'), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.getWriteoff({ orgId, id: Number(req.params.id) }) });
  } catch (e) { next(e);}
});

router.post('/', requirePermission('writeoffs.manage'), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    res.status(201).json({ data: await svc.createDraft({ orgId, actorUserId, payload: req.body }) });
  } catch (e) { next(e);}
});

router.post('/:id/submit', requirePermission('writeoffs.manage'), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    res.json({ data: await svc.submit({ orgId, id: Number(req.params.id), actorUserId }) });
  } catch (e) { next(e);}
});

router.post('/:id/approve', requirePermission('writeoffs.manage'), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    res.json({ data: await svc.approve({ orgId, id: Number(req.params.id), actorUserId }) });
  } catch (e) { next(e);}
});

router.post('/:id/reject', requirePermission('writeoffs.manage'), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { reason } = req.body;
    res.json({ data: await svc.reject({ orgId, id: Number(req.params.id), actorUserId, reason }) });
  } catch (e) { next(e);}
});

router.post('/:id/post', requirePermission('writeoffs.manage'), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { postingDate } = req.body;
    res.json({ data: await svc.post({ orgId, id: Number(req.params.id), actorUserId, postingDate }) });
  } catch (e) { next(e);}
});

router.post('/:id/void', requirePermission('writeoffs.manage'), async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    res.json({ data: await svc.voidWriteoff({ orgId, id: Number(req.params.id), actorUserId }) });
  } catch (e) { next(e);}
});

module.exports = router;
