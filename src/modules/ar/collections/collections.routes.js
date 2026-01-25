const express = require('express');
const { requirePermission } = require('../../../middleware/permission.middleware');
const svc = require('./collections.service');

const router = express.Router();

router.use(requirePermission('collections.read'));

router.get('/queue', async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { asOfDate, minDaysPastDue, includeDisputed } = req.query;
    const data = await svc.queue({
      orgId,
      asOfDate: asOfDate || new Date().toISOString().slice(0,10),
      minDaysPastDue: minDaysPastDue ? Number(minDaysPastDue) : 1,
      includeDisputed: includeDisputed === 'true'
    });

    res.json({ data });
  } catch (e) { next(e);}
});

router.get('/queue/:partnerId', async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { asOfDate } = req.query;
    const data = await svc.partnerOpenInvoices({ orgId, partnerId: Number(req.params.partnerId), asOfDate: asOfDate || new Date().toISOString().slice(0,10) });
    res.json({ data });
  } catch (e) { next(e);}
});

// Templates
router.get('/dunning/templates', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listTemplates({ orgId }) });
  } catch (e) { next(e);}
});
router.post('/dunning/templates', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.status(201).json({ data: await svc.createTemplate({ orgId, payload: req.body }) });
  } catch (e) { next(e);}
});
router.patch('/dunning/templates/:id', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.updateTemplate({ orgId, id: Number(req.params.id), payload: req.body }) });
  } catch (e) { next(e);}
});
router.delete('/dunning/templates/:id', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.deleteTemplate({ orgId, id: Number(req.params.id) }) });
  } catch (e) { next(e);}
});

// Rules
router.get('/dunning/rules', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listRules({ orgId }) });
  } catch (e) { next(e);}
});
router.post('/dunning/rules', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.status(201).json({ data: await svc.createRule({ orgId, payload: req.body }) });
  } catch (e) { next(e);}
});
router.patch('/dunning/rules/:id', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.updateRule({ orgId, id: Number(req.params.id), payload: req.body }) });
  } catch (e) { next(e);}
});
router.delete('/dunning/rules/:id', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.deleteRule({ orgId, id: Number(req.params.id) }) });
  } catch (e) { next(e);}
});

// Cases
router.get('/cases', requirePermission('collections.read'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { status } = req.query;
    res.json({ data: await svc.listCases({ orgId, status }) });
  } catch (e) { next(e);}
});
router.post('/cases', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    res.status(201).json({ data: await svc.createCase({ orgId, actorUserId, payload: req.body }) });
  } catch (e) { next(e);}
});
router.patch('/cases/:id', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.updateCase({ orgId, caseId: Number(req.params.id), payload: req.body }) });
  } catch (e) { next(e);}
});
router.post('/cases/:id/actions', requirePermission('collections.manage'), async (req,res,next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { action_type, payload } = req.body;
    res.status(201).json({ data: await svc.addAction({ orgId, caseId: Number(req.params.id), actorUserId, action_type, payload }) });
  } catch (e) { next(e);}
});

// Dunning runs
router.get('/dunning/runs', requirePermission('collections.read'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.listDunningRuns({ orgId }) });
  } catch (e) { next(e);}
});
router.get('/dunning/runs/:id', requirePermission('collections.read'), async (req,res,next) => {
  try {
    const { organization_id: orgId } = req.user;
    res.json({ data: await svc.getDunningRun({ orgId, runId: Number(req.params.id) }) });
  } catch (e) { next(e);}
});
router.post('/dunning/runs', requirePermission('collections.dunning.run'), async (req,res,next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const { ruleId, asOfDate } = req.body;
    res.status(201).json({ data: await svc.generateDunningRun({ orgId, actorUserId, ruleId: Number(ruleId), asOfDate: asOfDate || new Date().toISOString().slice(0,10) }) });
  } catch (e) { next(e);}
});

module.exports = router;
