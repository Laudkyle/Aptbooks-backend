/**
 * Accrual Runner API (Tier 1)
 * Used by Tier >= 2 modules and scheduled tasks. No direct repository exposure.
 */
const accrualSvc = require("../core/accounting/accruals/accruals.service");

async function createAccrualRule({ orgId, actorUserId, payload }) {
  return accrualSvc.createRule({ orgId, actorUserId, payload });
}

async function runDueAccruals({ orgId, actorUserId, asOfDate }) {
  return accrualSvc.runDueAccruals({ orgId, actorUserId, asOfDate });
}

async function runPeriodEndAccruals({ orgId, actorUserId, periodId, asOfDateOverride }) {
  return accrualSvc.runPeriodEndAccruals({ orgId, actorUserId, periodId, asOfDateOverride });
}

async function runOneAccrual({ orgId, actorUserId, ruleId, asOfDate, periodId }) {
  return accrualSvc.runOne({ orgId, actorUserId, ruleId, asOfDate, periodId });
}
async function runReversals({ orgId, actorUserId, periodId }) {
  return accrualSvc.runReversals({ orgId, actorUserId, periodId });
}
module.exports = {
  createAccrualRule,
  runDueAccruals,
  runPeriodEndAccruals,
  runOneAccrual, runReversals
};
