const express = require('express');
const { authRequired } = require('../../middleware/auth.middleware');

const collectionsRoutes = require('./collections/collections.routes');
const disputesRoutes = require('./disputes/disputes.routes');
const writeoffsRoutes = require('./writeoffs/writeoffs.routes');
const paymentPlansRoutes = require('./payment-plans/paymentPlans.routes');

const router = express.Router();

router.use(authRequired);

router.use('/collections', collectionsRoutes);
router.use('/disputes', disputesRoutes);
router.use('/writeoffs', writeoffsRoutes);
router.use('/payment-plans', paymentPlansRoutes);

module.exports = router;
