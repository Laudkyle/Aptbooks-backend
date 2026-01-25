/**
 * Balance Inquiry API (Tier 1)
 */
const balancesSvc = require("../core/accounting/ledger/balances.service");

async function trialBalance({ orgId, periodId }) {
  return balancesSvc.trialBalance({ orgId, periodId });
}

async function glBalances({ orgId, periodId }) {
  return balancesSvc.glBalances({ orgId, periodId });
}

async function accountActivity({ orgId, accountId, fromDate, toDate }) {
  return balancesSvc.accountActivity({ orgId, accountId, fromDate, toDate });
}

module.exports = { trialBalance, glBalances, accountActivity };
