const express = require('express');
const { requirePermission, requireAnyPermission } = require('../../middleware/permission.middleware');
const { idempotency } = require('../../middleware/idempotency.middleware');
const { createModuleBodyContract } = require('../../shared/http/requestValidation');
const svc = require('./dashboards.service');
const { resolveOrgId } = require('../_util');

const router=express.Router();
router.use(createModuleBodyContract([
  'name','description','visibility','version','defaultFilters','widgets','metricKey','metric_key','visualization','widgetType','config','configJson','position','positionJson','isArchived',
  'requests','key','groupBy','filters','shares','principalType','userId','roleId','canEdit','placements','locationKey','scope','sortOrder','isDefault','dashboardId','definition'
]));
const readAny=requireAnyPermission(['reporting.dashboards.read','reporting.dashboards.manage']);
function ctx(req){return{organizationId:resolveOrgId(req),userId:req.user.id,ip:req.ip,userAgent:req.headers['user-agent']};}
function idem(){return idempotency({required:true});}

// Global semantic metric layer.
router.get('/metrics',readAny,async(req,res,next)=>{try{res.json({data:await svc.listMetrics(ctx(req))});}catch(e){next(e);}});
router.post('/metrics/execute',readAny,async(req,res,next)=>{try{res.json({data:await svc.executeMetrics(ctx(req),req.body||{})});}catch(e){next(e);}});
router.post('/metrics/execute-one',readAny,async(req,res,next)=>{try{res.json({data:await svc.executeMetric(ctx(req),req.body||{})});}catch(e){next(e);}});

// Reusable templates. System templates are immutable; user/org templates are versioned.
router.get('/templates',readAny,async(req,res,next)=>{try{res.json({data:await svc.listTemplates(ctx(req),{includeArchived:req.query.includeArchived==='true'})});}catch(e){next(e);}});
router.post('/templates',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.status(201).json({data:await svc.createTemplate(ctx(req),req.body||{})});}catch(e){next(e);}});
router.get('/templates/:templateId',readAny,async(req,res,next)=>{try{res.json({data:await svc.getTemplate(ctx(req),req.params.templateId)});}catch(e){next(e);}});
router.put('/templates/:templateId',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.json({data:await svc.saveTemplate(ctx(req),req.params.templateId,req.body||{})});}catch(e){next(e);}});
router.post('/templates/:templateId/instantiate',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.status(201).json({data:await svc.instantiateTemplate(ctx(req),req.params.templateId,req.body||{})});}catch(e){next(e);}});
router.post('/templates/:templateId/archive',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.json({data:await svc.archiveTemplate(ctx(req),req.params.templateId)});}catch(e){next(e);}});

// Placement discovery used by application/module homes.
router.get('/location/:locationKey',readAny,async(req,res,next)=>{try{res.json({data:await svc.dashboardsForLocation(ctx(req),req.params.locationKey)});}catch(e){next(e);}});

router.get('/',readAny,async(req,res,next)=>{try{res.json({data:await svc.listDashboards(ctx(req),{includeArchived:req.query.includeArchived==='true',limit:req.query.limit,offset:req.query.offset})});}catch(e){next(e);}});
router.post('/',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.status(201).json({data:await svc.createDashboard(ctx(req),req.body||{})});}catch(e){next(e);}});
router.get('/:dashboardId',readAny,async(req,res,next)=>{try{res.json({data:await svc.getDashboard(ctx(req),req.params.dashboardId)});}catch(e){next(e);}});
router.put('/:dashboardId/design',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.json({data:await svc.saveDesign(ctx(req),req.params.dashboardId,req.body||{})});}catch(e){next(e);}});
router.patch('/:dashboardId',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.json({data:await svc.updateDashboard(ctx(req),req.params.dashboardId,req.body||{})});}catch(e){next(e);}});
router.post('/:dashboardId/archive',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.json({data:await svc.archiveDashboard(ctx(req),req.params.dashboardId)});}catch(e){next(e);}});

router.get('/:dashboardId/widgets',readAny,async(req,res,next)=>{try{res.json({data:await svc.listWidgets(ctx(req),req.params.dashboardId,req.query.includeArchived==='true')});}catch(e){next(e);}});
router.post('/:dashboardId/widgets',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.status(201).json({data:await svc.createWidget(ctx(req),req.params.dashboardId,req.body||{})});}catch(e){next(e);}});
router.patch('/widgets/:widgetId',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.json({data:await svc.updateWidget(ctx(req),req.params.widgetId,req.body||{})});}catch(e){next(e);}});

router.get('/:dashboardId/shares',requirePermission('reporting.dashboards.manage'),async(req,res,next)=>{try{res.json({data:await svc.listShares(ctx(req),req.params.dashboardId)});}catch(e){next(e);}});
router.put('/:dashboardId/shares',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.json({data:await svc.saveShares(ctx(req),req.params.dashboardId,req.body||{})});}catch(e){next(e);}});
router.get('/:dashboardId/placements',readAny,async(req,res,next)=>{try{res.json({data:await svc.listPlacements(ctx(req),req.params.dashboardId)});}catch(e){next(e);}});
router.put('/:dashboardId/placements',requirePermission('reporting.dashboards.manage'),idem(),async(req,res,next)=>{try{res.json({data:await svc.savePlacements(ctx(req),req.params.dashboardId,req.body||{})});}catch(e){next(e);}});
router.get('/:dashboardId/revisions',readAny,async(req,res,next)=>{try{res.json({data:await svc.listRevisions(ctx(req),req.params.dashboardId)});}catch(e){next(e);}});
router.get('/:dashboardId/snapshots',readAny,async(req,res,next)=>{try{res.json({data:await svc.listSnapshots(ctx(req),req.params.dashboardId)});}catch(e){next(e);}});
router.post('/:dashboardId/snapshots',readAny,idem(),async(req,res,next)=>{try{res.status(201).json({data:await svc.createSnapshot(ctx(req),req.params.dashboardId,req.body||{})});}catch(e){next(e);}});

module.exports=router;
