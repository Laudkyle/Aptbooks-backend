
const express = require('express');
const { authRequired } = require('../../../../middleware/auth.middleware');
const { requirePermission } = require('../../../../middleware/permission.middleware');
const svc = require('./cashForecast.service');

const router = express.Router();
router.use(authRequired);
router.get('/', requirePermission('banking.treasury.read'), async (req, res, next) => { try { res.json(await svc.generate(req.user.organization_id, req.query, req.user.id)); } catch (e) { next(e); } });
router.get('/snapshots', requirePermission('banking.treasury.read'), async (req, res, next) => { try { res.json(await svc.listSnapshots(req.user.organization_id)); } catch (e) { next(e); } });

module.exports = router;
