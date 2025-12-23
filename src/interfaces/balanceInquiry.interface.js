/**
 * Balance Inquiry API (Tier 1)
 */
const balancesSvc = require("../core/accounting/ledger/balances.service");

async function trialBalance({ orgId, periodId }) {
  return balancesSvc.trialBalance({ orgId, periodId });
}

module.exports = { trialBalance };
