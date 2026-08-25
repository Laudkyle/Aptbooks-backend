const router = require('express').Router();
const { authRequired } = require('../../../middleware/auth.middleware');
const { requirePermission } = require('../../../middleware/permission.middleware');
const { getOverview } = require('./inventoryOverview.service');
router.use(authRequired);
router.get('/', requirePermission('inventory.items.read'), async (req,res,next)=>{ try { res.json(await getOverview(req.user.organization_id)); } catch(e){ next(e); } });
module.exports = router;
