const svc = require("../core/accounting/ledger/reconciliation.service");

async function reconcilePeriod(args) {
  return svc.reconcilePeriod(args);
}

async function getDiscrepancyDetails(args) {
  return svc.getDiscrepancyDetails(args);
}

async function autoCorrect(args) {
  return svc.autoCorrect(args);
}

async function rebuildBalances(args) {
  return svc.rebuildBalances(args);
}

async function getHistory(args) {
  return svc.getHistory(args);
}

async function getPolicy(args) {
  return svc.getPolicy(args);
}

async function upsertPolicy(args) {
  return svc.upsertPolicy(args);
}

async function exportReconciliation(args) {
  return svc.exportReconciliation(args);
}

module.exports = {
  reconcilePeriod,
  getDiscrepancyDetails,
  autoCorrect,
  rebuildBalances,
  getHistory,
  getPolicy,
  upsertPolicy,
  exportReconciliation,
};
