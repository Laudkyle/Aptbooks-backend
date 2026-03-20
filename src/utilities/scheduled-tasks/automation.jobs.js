const { pool } = require('../../db/pool');
const recurringSvc = require('../../modules/automation/recurring-transactions/recurringTransactions.service');
const autoRecSvc = require('../../modules/automation/auto-reconciliation/autoReconciliation.service');
const smartNotifSvc = require('../../modules/automation/smart-notifications/smartNotifications.service');

async function listOrgIds() {
  const { rows } = await pool.query(`SELECT id FROM organizations`);
  return rows.map((r) => r.id);
}

async function recurringTransactionsHourly() {
  const orgIds = await listOrgIds();
  let processed = 0;
  for (const orgId of orgIds) {
    const out = await recurringSvc.runDueRecurringTransactions({ orgId }).catch(() => ({ processed: 0 }));
    processed += Number(out.processed || 0);
  }
  return { message: `Processed ${processed} recurring transaction(s)` };
}

async function autoReconciliationHourly() {
  const orgIds = await listOrgIds();
  let processed = 0;
  for (const orgId of orgIds) {
    const profiles = await autoRecSvc.listProfiles(orgId).catch(() => ({ data: [] }));
    for (const p of (profiles.data || []).filter((x) => x.is_enabled)) {
      await autoRecSvc.runProfile(orgId, p.id).catch(() => null);
      processed += 1;
    }
  }
  return { message: `Processed ${processed} auto reconciliation profile(s)` };
}

async function smartNotificationsHourly() {
  const orgIds = await listOrgIds();
  let created = 0;
  for (const orgId of orgIds) {
    const out = await smartNotifSvc.executeEnabledRules({ orgId }).catch(() => ({ createdCount: 0 }));
    created += Number(out.createdCount || 0);
  }
  return { message: `Created ${created} smart notification(s)` };
}

module.exports = { recurringTransactionsHourly, autoReconciliationHourly, smartNotificationsHourly };
