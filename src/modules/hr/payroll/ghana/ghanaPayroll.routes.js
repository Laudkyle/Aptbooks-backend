const router = require('express').Router();
const { authRequired } = require('../../../../middleware/auth.middleware');
const { requirePermission } = require('../../../../middleware/permission.middleware');
const { idempotency } = require('../../../../middleware/idempotency.middleware');
const { validate } = require('../../../../shared/validators/validate');
const { writeAudit } = require('../../../../core/foundation/audit-logs/audit.service');
const {
  ghanaPayrollSettingsSchema, ghanaPreparePayeReturnSchema, ghanaMarkPayeFiledSchema,
  ghanaPrepareRemittanceSchema, ghanaMarkRemittancePaidSchema,
} = require('../../../../shared/validators/hr.payroll.validators');
const svc = require('./ghanaPayroll.service');

router.use(authRequired);

router.get('/settings', requirePermission('hr.payroll.ghana.read'), async (req,res,next)=>{ try { const data=await svc.ensureSettings({orgId:req.user.organization_id,actorUserId:req.user.id}); res.json(data); } catch(e){next(e);} });
router.patch('/settings', requirePermission('hr.payroll.ghana.manage'), async (req,res,next)=>{ try { const payload=validate(ghanaPayrollSettingsSchema,req.body); const data=await svc.updateSettings({orgId:req.user.organization_id,actorUserId:req.user.id,payload}); await writeAudit({organizationId:req.user.organization_id,actorUserId:req.user.id,action:'hr.ghana_payroll.settings.updated',entityType:'ghana_payroll_settings',entityId:req.user.organization_id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:data}); res.json(data); } catch(e){next(e);} });

router.get('/returns', requirePermission('hr.payroll.ghana.read'), async (req,res,next)=>{ try {res.json(await svc.listReturns({orgId:req.user.organization_id}));}catch(e){next(e);} });
router.get('/returns/:id', requirePermission('hr.payroll.ghana.read'), async (req,res,next)=>{ try {res.json(await svc.getReturn({orgId:req.user.organization_id,returnId:req.params.id}));}catch(e){next(e);} });
router.post('/returns', idempotency({required:true}), requirePermission('hr.payroll.ghana.manage'), async (req,res,next)=>{ try { const p=validate(ghanaPreparePayeReturnSchema,req.body); const data=await svc.prepareReturn({orgId:req.user.organization_id,actorUserId:req.user.id,formCode:p.formCode,periodStart:p.periodStart,periodEnd:p.periodEnd}); await writeAudit({organizationId:req.user.organization_id,actorUserId:req.user.id,action:'hr.ghana_paye.return.prepared',entityType:'ghana_paye_returns',entityId:data.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:data}); res.status(201).json(data); }catch(e){next(e);} });
router.post('/returns/:id/finalize', idempotency({required:true}), requirePermission('hr.payroll.ghana.file'), async (req,res,next)=>{ try { const data=await svc.finalizeReturn({orgId:req.user.organization_id,actorUserId:req.user.id,returnId:req.params.id}); await writeAudit({organizationId:req.user.organization_id,actorUserId:req.user.id,action:'hr.ghana_paye.return.finalized',entityType:'ghana_paye_returns',entityId:data.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:data}); res.json(data);}catch(e){next(e);} });
router.post('/returns/:id/filed', idempotency({required:true}), requirePermission('hr.payroll.ghana.file'), async (req,res,next)=>{ try { const p=validate(ghanaMarkPayeFiledSchema,req.body); const data=await svc.markFiled({orgId:req.user.organization_id,actorUserId:req.user.id,returnId:req.params.id,graReference:p.graReference}); await writeAudit({organizationId:req.user.organization_id,actorUserId:req.user.id,action:'hr.ghana_paye.return.filed',entityType:'ghana_paye_returns',entityId:data.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:data}); res.json(data);}catch(e){next(e);} });
router.get('/returns/:id/export.csv', requirePermission('hr.payroll.ghana.read'), async (req,res,next)=>{ try { const out=await svc.exportReturnCsv({orgId:req.user.organization_id,returnId:req.params.id}); res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition',`attachment; filename="${out.filename}"`); res.send(out.content); }catch(e){next(e);} });

router.get('/pension-schedule', requirePermission('hr.payroll.ghana.read'), async (req,res,next)=>{ try {res.json(await svc.contributionSchedule({orgId:req.user.organization_id,periodStart:req.query.periodStart,periodEnd:req.query.periodEnd}));}catch(e){next(e);} });
router.get('/disengaged-schedule', requirePermission('hr.payroll.ghana.read'), async (req,res,next)=>{ try {res.json(await svc.disengagedSchedule({orgId:req.user.organization_id,periodStart:req.query.periodStart,periodEnd:req.query.periodEnd}));}catch(e){next(e);} });

router.get('/remittances', requirePermission('hr.payroll.ghana.read'), async (req,res,next)=>{try{res.json(await svc.listRemittances({orgId:req.user.organization_id}));}catch(e){next(e);}});
router.post('/remittances', idempotency({required:true}), requirePermission('hr.payroll.ghana.manage'), async (req,res,next)=>{try{const p=validate(ghanaPrepareRemittanceSchema,req.body); const data=await svc.prepareRemittance({orgId:req.user.organization_id,actorUserId:req.user.id,type:p.type,periodStart:p.periodStart,periodEnd:p.periodEnd}); await writeAudit({organizationId:req.user.organization_id,actorUserId:req.user.id,action:'hr.ghana_payroll.remittance.prepared',entityType:'ghana_payroll_remittances',entityId:data.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:data}); res.status(201).json(data);}catch(e){next(e);}});
router.post('/remittances/:id/paid', idempotency({required:true}), requirePermission('hr.payroll.ghana.manage'), async (req,res,next)=>{try{const p=validate(ghanaMarkRemittancePaidSchema,req.body); const data=await svc.markRemittancePaid({orgId:req.user.organization_id,id:req.params.id,actorUserId:req.user.id,settlementAccountId:p.settlementAccountId,paymentDate:p.paymentDate,paymentReference:p.paymentReference}); await writeAudit({organizationId:req.user.organization_id,actorUserId:req.user.id,action:'hr.ghana_payroll.remittance.paid',entityType:'ghana_payroll_remittances',entityId:data.id,ip:req.audit?.ip,userAgent:req.audit?.userAgent,after:data}); res.json(data);}catch(e){next(e);}});

module.exports = router;
