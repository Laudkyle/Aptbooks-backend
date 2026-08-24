const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const express = require('express');
const { requirePermission } = require('../../../middleware/permission.middleware');
const svc = require('./disputes.service');

const router = express.Router();

router.use(createModuleBodyContract(['action_type', 'code', 'description', 'entity_id', 'entity_type', 'is_active', 'notes', 'partner_id', 'payload', 'reason_code', 'resolution']));
router.get('/reason-codes', requirePermission('disputes.read'), async (req,res,next)=>{
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listReasonCodes({ orgId }) });
  } catch(e){ next(e); }
});

router.post('/reason-codes', requirePermission('disputes.manage'), async (req,res,next)=>{
  try {
    const { organization_id: orgId } = req.user;
    res.status(201).json({ data: await svc.upsertReasonCode({ orgId, payload: req.body }) });
  } catch(e){ next(e); }
});

router.delete('/reason-codes/:code', requirePermission('disputes.manage'), async (req,res,next)=>{
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.deleteReasonCode({ orgId, code: req.params.code }) });
  } catch(e){ next(e); }
});

router.get('/', requirePermission('disputes.read'), async (req,res,next)=>{
  try {
    const { organization_id: orgId } = req.user;
    const { status } = req.query;
    res.json({ data: await svc.listDisputes({ orgId, status }) });
  } catch(e){ next(e); }
});

router.get('/:id', requirePermission('disputes.read'), async (req,res,next)=>{
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.getDispute({ orgId, id: Number(req.params.id) }) });
  } catch(e){ next(e); }
});

router.post('/', requirePermission('disputes.manage'), async (req,res,next)=>{
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    res.status(201).json({ data: await svc.createDispute({ orgId, actorUserId, payload: req.body }) });
  } catch(e){ next(e); }
});

router.post('/:id/actions', requirePermission('disputes.manage'), async (req,res,next)=>{
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { action_type, payload } = req.body;
    res.status(201).json({ data: await svc.addAction({ orgId, id: Number(req.params.id), actorUserId, action_type, payload }) });
  } catch(e){ next(e); }
});

router.post('/:id/resolve', requirePermission('disputes.manage'), async (req,res,next)=>{
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { resolution } = req.body;
    res.json({ data: await svc.resolveDispute({ orgId, id: Number(req.params.id), actorUserId, resolution }) });
  } catch(e){ next(e); }
});

router.post('/:id/void', requirePermission('disputes.manage'), async (req,res,next)=>{
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    res.json({ data: await svc.voidDispute({ orgId, id: Number(req.params.id), actorUserId }) });
  } catch(e){ next(e); }
});

module.exports = router;
