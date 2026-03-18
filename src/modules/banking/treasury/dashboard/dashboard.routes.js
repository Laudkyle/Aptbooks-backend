
const express = require('express');
const { authRequired } = require('../../../../middleware/auth.middleware');
const { requirePermission } = require('../../../../middleware/permission.middleware');
const svc = require('./dashboard.service');

const router = express.Router();
router.use(authRequired);
router.get('/', requirePermission('banking.treasury.read'), async (req, res, next) => { try { res.json(await svc.getDashboard(req.user.organization_id)); } catch (e) { next(e); } });

module.exports = router;
