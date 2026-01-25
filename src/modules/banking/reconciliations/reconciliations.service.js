const repo = require("./reconciliations.repository"); 
const { AppError } = require("../../../shared/errors/AppError"); 
const { pool } = require("../../../db/pool"); 
const { withTransaction } = require("../../../db/tx"); 
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service"); 

async function reconcile(orgId, userId, payload) {
  const req=["bankAccountId","periodId"]; 
  for (const k of req) if (!payload?.[k]) throw new AppError(400, `${k} is required`); 


  return withTransaction(async (client) => {
    // Prevent concurrent reconciliations for the same org/account/period
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`recon:${orgId}:${payload.bankAccountId}:${payload.periodId}`]
    ); 

    // Validate bank account belongs to org
    const { rows: ba } = await client.query(
      `SELECT id FROM bank_accounts WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.bankAccountId]
    ); 
    if (!ba.length) throw new AppError(404, "Bank account not found"); 

    // Ensure period open (reconcile only within open periods)
    const { rows: p } = await client.query(
      `SELECT status FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.periodId]
    ); 
    if (!p.length) throw new AppError(404, "Period not found"); 
    if (p[0].status !== "open") throw new AppError(409, "Period not open"); 

    // Natural idempotency: if an active reconciliation already exists, return it.
    const existing = await repo.findActive(orgId, payload.bankAccountId, payload.periodId, client); 
    if (existing) return existing; 

    const created = await repo.create(orgId, userId, payload, client); 
    await writeAudit({
      organizationId: orgId,
      actorUserId: userId,
      action: "BANK_RECONCILIATION_CREATED",
      entityType: "bank_reconciliation",
      entityId: created.id,
      after: {
        bank_account_id: payload.bankAccountId,
        period_id: payload.periodId
      }
    }); 
    return created; 
  }); 
}

async function listReconciliations(orgId, query) {
  return { data: await repo.list(orgId, query || {}) }; 
}

async function getReconciliation(orgId, id) {
  const r = await repo.getById(orgId, id); 
  if (!r) throw new AppError(404, "Reconciliation not found"); 
  return { data: r }; 
}

async function closeReconciliation(orgId, userId, id, payload = {}) {
  const note = payload.note || payload.close_note || null; 
  return withTransaction(async (client) => {
    const cur = await repo.getById(orgId, id, client, true); 
    if (!cur) throw new AppError(404, "Reconciliation not found"); 
    const updated = await repo.close(orgId, id, userId, note, client); 
    await writeAudit({
      organizationId: orgId,
      actorUserId: userId,
      action: "BANK_RECONCILIATION_CLOSED",
      entityType: "bank_reconciliation",
      entityId: id,
      after: { is_locked: true, note }
    }); 
    return { data: updated }; 
  }); 
}

async function unlockReconciliation(orgId, userId, id) {
  return withTransaction(async (client) => {
    const cur = await repo.getById(orgId, id, client, true); 
    if (!cur) throw new AppError(404, "Reconciliation not found"); 
    const updated = await repo.unlock(orgId, id, userId, client); 
    await writeAudit({
      organizationId: orgId,
      actorUserId: userId,
      action: "BANK_RECONCILIATION_UNLOCKED",
      entityType: "bank_reconciliation",
      entityId: id,
      after: { is_locked: false }
    }); 
    return { data: updated }; 
  }); 
}

async function computeDiff(orgId, id) {
  const rec = await repo.getById(orgId, id); 
  if (!rec) throw new AppError(404, "Reconciliation not found"); 

  const { rows: periodRows } = await pool.query(
    `SELECT id, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, rec.period_id]
  ); 
  if (!periodRows.length) throw new AppError(404, "Period not found"); 
  const period = periodRows[0]; 

  const { rows: baRows } = await pool.query(
    `SELECT gl_account_id FROM bank_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, rec.bank_account_id]
  ); 
  if (!baRows.length) throw new AppError(404, "Bank account not found"); 

  const glAccountId = baRows[0].gl_account_id; 

  const { rows: glBalRows } = await pool.query(
    `SELECT debit_total, credit_total FROM general_ledger_balances WHERE organization_id=$1 AND period_id=$2 AND account_id=$3`,
    [orgId, period.id, glAccountId]
  ); 
  const glDebit = Number(glBalRows[0]?.debit_total || 0); 
  const glCredit = Number(glBalRows[0]?.credit_total || 0); 
  const ledgerBalance = glDebit - glCredit; 

  const { rows: stmtRows } = await pool.query(
    `
    SELECT closing_balance, statement_date
    FROM bank_statements
    WHERE organization_id=$1 AND bank_account_id=$2
      AND statement_date <= $3::date
    ORDER BY statement_date DESC
    LIMIT 1
    `,
    [orgId, rec.bank_account_id, period.end_date]
  ); 

  const statementBalance = stmtRows.length ? Number(stmtRows[0].closing_balance || 0) : null; 
  const statementDate = stmtRows.length ? stmtRows[0].statement_date : null; 
  const difference = statementBalance == null ? null : statementBalance - ledgerBalance; 

  return {
    data: {
      reconciliation_id: id,
      period: { id: period.id, start_date: period.start_date, end_date: period.end_date },
      ledger_balance: ledgerBalance,
      statement_balance: statementBalance,
      statement_date: statementDate,
      difference
    }
  }; 
}

module.exports = {
  reconcile,
  listReconciliations,
  getReconciliation,
  closeReconciliation,
  unlockReconciliation,
  computeDiff
}; 
