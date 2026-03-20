const router = require('express').Router();
const { authRequired } = require('../../middleware/auth.middleware');

router.use(authRequired);
router.use('/recurring-transactions', require('./recurring-transactions/recurringTransactions.routes'));
router.use('/accounting-jobs', require('./accounting-jobs/accountingJobs.routes'));
router.use('/auto-reconciliation', require('./auto-reconciliation/autoReconciliation.routes'));
router.use('/document-matching', require('./document-matching/documentMatching.routes'));
router.use('/ai-classification', require('./ai-classification/aiClassification.routes'));
router.use('/smart-notifications', require('./smart-notifications/smartNotifications.routes'));

module.exports = router;
