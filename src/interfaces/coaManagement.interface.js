/**
 * Chart of Accounts API (Tier 1)
 * Routes and higher tiers should use this boundary.
 */

const coaSvc = require("../core/accounting/chart-of-accounts/coa.service");

async function createAccount({ orgId, payload }) {
  return coaSvc.createAccount({ orgId, payload });
}

async function listAccounts({ orgId, includeArchived = false }) {
  return coaSvc.listAccounts({ orgId, includeArchived });
}

async function getAccount({ orgId, accountId }) {
  return coaSvc.getAccount({ orgId, accountId });
}

async function updateAccount({ orgId, accountId, payload }) {
  return coaSvc.updateAccount({ orgId, accountId, payload });
}

async function archiveAccount({ orgId, accountId, actorUserId }) {
  return coaSvc.archiveAccount({ orgId, accountId, actorUserId });
}

module.exports = {
  createAccount,
  listAccounts,
  getAccount,
  updateAccount,
  archiveAccount
};
