const express = require('express');
const { z, validateBody } = require('../../../../shared/http/requestValidation');
const { authRequired } = require('../../../../middleware/auth.middleware');
const { requirePermission, requireAnyPermission } = require('../../../../middleware/permission.middleware');
const { idempotency } = require('../../../../middleware/idempotency.middleware');
const svc = require('./treasuryControls.service');
const router = express.Router();
const schema = z.object({
  enforceMakerChecker: z.boolean().optional(),
  requireExecutionByDifferentUser: z.boolean().optional(),
  requirePaymentRunApproval: z.boolean().optional(),
  requireTransferApproval: z.boolean().optional(),
  defaultReconciliationTolerance: z.union([z.string(), z.number()]).optional(),
}).strict();
router.use(authRequired);
router.get('/', requireAnyPermission(['banking.treasury.read','banking.treasury.manage']), async (req,res,next)=>{ try { res.json(await svc.get(req.user.organization_id)); } catch(e){ next(e); } });
router.put('/', idempotency({required:true}), requirePermission('banking.treasury.manage'), validateBody(schema), async (req,res,next)=>{ try { res.json(await svc.upsert(req.user.organization_id, req.user.id, req.body)); } catch(e){ next(e); } });
module.exports = router;
