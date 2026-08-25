const router=require('express').Router();
const {authRequired}=require('../../../middleware/auth.middleware');
const {requireAnyPermission}=require('../../../middleware/permission.middleware');
const svc=require('./overview.service');
router.use(authRequired);
router.get('/',requireAnyPermission(['banking.accounts.read','banking.statements.read','banking.reconciliations.read']),async(req,res,next)=>{try{res.json(await svc.getWorkspace(req.user.organization_id));}catch(e){next(e);}});
module.exports=router;
