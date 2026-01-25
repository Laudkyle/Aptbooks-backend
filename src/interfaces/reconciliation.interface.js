const svc = require("../core/accounting/ledger/reconciliation.service");

async function reconcilePeriod({ orgId, periodId }) {
  return svc.reconcilePeriod({ orgId, periodId });
}

module.exports = { reconcilePeriod };
