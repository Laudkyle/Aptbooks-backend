const repo = require('./reconciliations.repository');
const { AppError } = require('../../../shared/errors/AppError');
const { withTransaction } = require('../../../db/tx');
const { writeAudit } = require('../../../core/foundation/audit-logs/audit.service');
const { moneyUnits, absUnits } = require('../../../shared/utils/financialMath');

async function assertPeriodOpen(orgId, periodId, client) {
  const { rows } = await client.query(
    `SELECT id, status FROM accounting_periods WHERE organization_id=$1 AND id=$2 FOR SHARE`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(404, 'Period not found');
  if (rows[0].status !== 'open') {
    throw new AppError(409, 'Bank reconciliation cannot be changed while its accounting period is closed');
  }
}

async function reconcile(orgId, userId, payload) {
  for (const key of ['bankAccountId', 'periodId']) {
    if (!payload?.[key]) throw new AppError(400, `${key} is required`);
  }
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`recon:${orgId}:${payload.bankAccountId}:${payload.periodId}`]);
    const { rows: accounts } = await client.query(
      `SELECT id,is_active FROM bank_accounts WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.bankAccountId]
    );
    if (!accounts.length) throw new AppError(404, 'Bank account not found');
    if (!accounts[0].is_active) throw new AppError(409, 'Inactive bank accounts cannot start new reconciliations');
    await assertPeriodOpen(orgId, payload.periodId, client);
    const existing = await repo.findActive(orgId, payload.bankAccountId, payload.periodId, client);
    if (existing) return existing;
    const stmt = await repo.resolveStatement(orgId, payload.bankAccountId, payload.periodId, payload.statementId || payload.statement_id || null, client);
    if (!stmt) throw new AppError(409, 'A bank statement ending on or before the period end is required');
    if (stmt.status === 'draft') throw new AppError(409, 'Validate the bank statement before starting reconciliation');
    const created = await repo.create(orgId, userId, { bankAccountId: payload.bankAccountId, periodId: payload.periodId, statementId: stmt.id }, client);
    await writeAudit({ organizationId: orgId, actorUserId: userId, action: 'BANK_RECONCILIATION_CREATED', entityType: 'bank_reconciliation', entityId: created.id, after: { bank_account_id: payload.bankAccountId, period_id: payload.periodId, statement_id: stmt.id }, client });
    return created;
  });
}

async function listReconciliations(orgId, query) { return { data: await repo.list(orgId, query || {}) }; }
async function getReconciliation(orgId, id) {
  const row = await repo.getById(orgId, id);
  if (!row) throw new AppError(404, 'Reconciliation not found');
  return { data: row };
}

async function computeDiff(orgId, id, client = null) {
  const rec = await repo.getById(orgId, id, client);
  if (!rec) throw new AppError(404, 'Reconciliation not found');
  const control = await repo.computeControl(orgId, rec, client);
  if (!control?.statement_id) throw new AppError(409, 'Reconciliation has no statement control');
  return { data: { reconciliation_id: id, ...control } };
}

async function closeReconciliation(orgId, userId, id, payload = {}) {
  const note = payload.note || payload.close_note || null;
  return withTransaction(async (client) => {
    const current = await repo.getById(orgId, id, client, true);
    if (!current) throw new AppError(404, 'Reconciliation not found');
    if (current.is_locked) return { data: current, idempotent: true };
    await assertPeriodOpen(orgId, current.period_id, client);
    const control = await repo.computeControl(orgId, current, client);
    if (!control?.statement_id) throw new AppError(409, 'A validated statement is required');
    if (!['validated', 'locked'].includes(control.statement_status)) throw new AppError(409, 'Statement must be validated before reconciliation can close');
    if (Number(control.wrong_currency_lines) > 0) throw new AppError(409, 'Bank GL contains journal lines in a currency different from the bank account currency');
    if (Number(control.unmatched_count) > 0) throw new AppError(409, `Reconciliation cannot close while ${control.unmatched_count} statement line(s) remain unmatched`);
    if (absUnits(moneyUnits(control.difference)) > moneyUnits(control.tolerance_amount || 0)) {
      throw new AppError(409, `Reconciliation difference ${control.difference} exceeds tolerance ${control.tolerance_amount}`);
    }
    const updated = await repo.close(orgId, id, userId, note, control, client);
    await repo.setStatementStatus(orgId, control.statement_id, 'locked', userId, client);
    await writeAudit({ organizationId: orgId, actorUserId: userId, action: 'BANK_RECONCILIATION_CLOSED', entityType: 'bank_reconciliation', entityId: id, after: { ...control, is_locked: true, note }, client });
    return { data: updated, control };
  });
}

async function unlockReconciliation(orgId, userId, id) {
  return withTransaction(async (client) => {
    const current = await repo.getById(orgId, id, client, true);
    if (!current) throw new AppError(404, 'Reconciliation not found');
    if (!current.is_locked) return { data: current, idempotent: true };
    await assertPeriodOpen(orgId, current.period_id, client);
    const updated = await repo.unlock(orgId, id, client);
    if (current.statement_id) await repo.setStatementStatus(orgId, current.statement_id, 'validated', null, client);
    await writeAudit({ organizationId: orgId, actorUserId: userId, action: 'BANK_RECONCILIATION_UNLOCKED', entityType: 'bank_reconciliation', entityId: id, before: { is_locked: true }, after: { is_locked: false }, client });
    return { data: updated };
  });
}

module.exports = { reconcile, listReconciliations, getReconciliation, closeReconciliation, unlockReconciliation, computeDiff };
