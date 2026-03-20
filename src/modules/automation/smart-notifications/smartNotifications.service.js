const repo = require('./smartNotifications.repository');
const notifSvc = require('../../../notifications/notifications.service');
const recurringRepo = require('../recurring-transactions/recurringTransactions.repository');
const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');

async function listRules(orgId) { return { data: await repo.listRules(orgId) }; }
async function createRule(orgId, userId, payload) {
  if (!payload?.code) throw new AppError(400, 'code is required');
  if (!payload?.name) throw new AppError(400, 'name is required');
  if (!payload?.triggerType) throw new AppError(400, 'triggerType is required');
  return { data: await repo.createRule(orgId, userId, payload) };
}
async function updateRule(orgId, id, payload) { const row = await repo.updateRule(orgId, id, payload || {}); if (!row) throw new AppError(404, 'Smart notification rule not found'); return { data: row }; }

async function evaluateRule(orgId, actorUserId, rule) {
  const cfg = rule.config_json || {};
  const created = [];
  if (rule.trigger_type === 'scheduler_failures') {
    const { rows } = await pool.query(
      `SELECT task_code, COUNT(*)::int AS failed_count
       FROM scheduled_task_runs
       WHERE status='failed' AND started_at >= (NOW() - make_interval(days => $1::int))
       GROUP BY task_code`,
      [cfg.windowDays || 1]
    ).catch(() => ({ rows: [] }));
    for (const r of rows || []) {
      created.push(await notifSvc.createNotification({ orgId, actorUserId, payload: {
        userId: rule.target_user_id || null,
        type: 'automation', severity: rule.severity || 'warning',
        title: `Scheduled task failures detected`,
        body: `${r.task_code} failed ${r.failed_count} time(s) in the monitoring window.`,
        entityType: 'scheduled_task', entityId: r.task_code
      }}));
    }
  } else if (rule.trigger_type === 'recurring_due') {
    const due = await recurringRepo.listDue(orgId, new Date().toISOString().slice(0,10));
    for (const item of due.slice(0, Number(cfg.maxItems || 20))) {
      created.push(await notifSvc.createNotification({ orgId, actorUserId, payload: {
        userId: rule.target_user_id || null,
        type: 'automation', severity: rule.severity || 'info',
        title: `Recurring transaction due`,
        body: `${item.code} - ${item.name} is due to run on ${item.next_run_date}.`,
        entityType: 'automation_recurring_transaction', entityId: item.id
      }}));
    }
  } else if (rule.trigger_type === 'low_bank_balance') {
    const threshold = Number(cfg.threshold || 0);
    const { rows } = await pool.query(
      `SELECT ba.id, ba.code, ba.name, COALESCE(SUM(bt.amount),0) AS balance
       FROM bank_accounts ba
       LEFT JOIN bank_transactions bt ON bt.organization_id = ba.organization_id AND bt.bank_account_id = ba.id
       WHERE ba.organization_id=$1
       GROUP BY ba.id, ba.code, ba.name
       HAVING COALESCE(SUM(bt.amount),0) < $2::numeric`,
      [orgId, threshold]
    );
    for (const r of rows) {
      created.push(await notifSvc.createNotification({ orgId, actorUserId, payload: {
        userId: rule.target_user_id || null,
        type: 'automation', severity: rule.severity || 'warning',
        title: `Low bank balance`,
        body: `${r.code || ''} ${r.name || ''}`.trim() + ` balance is ${r.balance}.`,
        entityType: 'bank_account', entityId: r.id
      }}));
    }
  }
  return created;
}

async function executeRule(orgId, actorUserId, id) {
  const rule = await repo.getRule(orgId, id);
  if (!rule) throw new AppError(404, 'Smart notification rule not found');
  const items = await evaluateRule(orgId, actorUserId, rule);
  return { data: { rule, createdCount: items.length, items } };
}
async function executeEnabledRules({ orgId, actorUserId = null } = {}) {
  const rules = (await repo.listRules(orgId)).filter((r) => r.is_enabled);
  let createdCount = 0;
  for (const rule of rules) {
    try { const items = await evaluateRule(orgId, actorUserId, rule); createdCount += items.length; } catch (_) {}
  }
  return { message: `Created ${createdCount} smart notification(s)`, createdCount };
}
module.exports = { listRules, createRule, updateRule, executeRule, executeEnabledRules };
