const express = require('express'); 
const { requirePermission } = require('../../../middleware/permission.middleware'); 
const svc = require('./paymentPlans.service'); 

const router = express.Router(); 

router.get('/', requirePermission('payment_plans.read'), async (req,res,next)=>{
  try{
    const { organization_id: orgId } = req.user; 
    const { status } = req.query; 
    res.json({ data: await svc.listPlans({ orgId, status }) }); 
  } catch(e){ next(e);  }
}); 

router.get('/:id', requirePermission('payment_plans.read'), async (req,res,next)=>{
  try{
    const { organization_id: orgId } = req.user; 
    res.json({ data: await svc.getPlan({ orgId, id: Number(req.params.id) }) }); 
  } catch(e){ next(e);  }
}); 

router.post('/', requirePermission('payment_plans.manage'), async (req,res,next)=>{
  try{
    const { organization_id: orgId, id: actorUserId } = req.user; 
    res.status(201).json({ data: await svc.createPlan({ orgId, actorUserId, payload: req.body }) }); 
  } catch(e){ next(e);  }
}); 

router.post('/:id/cancel', requirePermission('payment_plans.manage'), async (req,res,next)=>{
  try{
    const { organization_id: orgId, id: actorUserId } = req.user; 
    res.json({ data: await svc.cancelPlan({ orgId, id: Number(req.params.id), actorUserId }) }); 
  } catch(e){ next(e);  }
}); 

router.post('/:id/installments/:installmentId/mark-paid', requirePermission('payment_plans.manage'), async (req,res,next)=>{
  try{
    const { organization_id: orgId, id: actorUserId } = req.user; 
    const { settlement_ref } = req.body; 
    res.json({ data: await svc.markInstallmentPaid({ orgId, id: Number(req.params.id), installmentId: Number(req.params.installmentId), actorUserId, settlement_ref }) }); 
  } catch(e){ next(e);  }
}); 

module.exports = router; 
