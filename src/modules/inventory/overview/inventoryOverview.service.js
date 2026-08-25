const repo = require('./inventoryOverview.repository');
function n(value) { return Number(value || 0); }

async function getOverview(orgId) {
  const { summary: s, warehouses, lowStock, workflow: w, anomalies: a, recent } = await repo.loadOverview(orgId);
  const anomalyCount = n(a.negative_balances)+n(a.negative_costs)+n(a.broken_master_links)+n(a.stock_in_inactive_warehouses)+n(w.posted_without_journal);
  return {
    summary: {
      activeItems: n(s.active_items), inactiveItems: n(s.inactive_items),
      batchTrackedItems: n(s.batch_tracked_items), serialTrackedItems: n(s.serial_tracked_items),
      quantityOnHand: s.quantity_on_hand || '0', inventoryValue: s.inventory_value || '0'
    },
    workflow: {
      draftTransactions: n(w.draft_transactions), submittedTransactions: n(w.submitted_transactions),
      approvedUnpostedTransactions: n(w.approved_unposted_transactions), postedWithoutJournal: n(w.posted_without_journal)
    },
    integrity: {
      status: anomalyCount === 0 ? 'healthy' : 'attention', anomalyCount,
      negativeBalances: n(a.negative_balances), negativeCosts: n(a.negative_costs),
      brokenMasterLinks: n(a.broken_master_links), stockInInactiveWarehouses: n(a.stock_in_inactive_warehouses)
    },
    warehouses,
    reorderAttention: lowStock,
    recentTransactions: recent
  };
}
module.exports = { getOverview };
