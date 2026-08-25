const repo = require('./cheques.repository');
const paymentRunsRepo = require('../payment-runs/paymentRuns.repository');
const { AppError } = require('../../../../shared/errors/AppError');
const { withTransaction } = require('../../../../db/tx');
const journalIF = require('../../../../interfaces/journalPosting.interface');
const { normalizeAmount, findOpenPeriodId } = require('../_shared/helpers');
const { moneyUnits, moneyStringFromUnits, sumMoneyUnits } = require('../../../../shared/utils/financialMath');
const controlsSvc = require('../controls/treasuryControls.service');
const { writeAudit } = require('../../../../core/foundation/audit-logs/audit.service');

async function list(orgId, filters) { return repo.list(orgId, filters); }
async function get(orgId, id) {
  const row = await repo.get(orgId, id);
  if (!row) throw new AppError(404, 'Cheque not found');
  return row;
}

async function loadPaymentRunForCheque(orgId, paymentRunId, client, { lock = false } = {}) {
  if (!paymentRunId) return null;
  if (lock) await paymentRunsRepo.lockHeader(orgId, paymentRunId, client);
  const run = await paymentRunsRepo.get(orgId, paymentRunId, client);
  if (!run) throw new AppError(404, 'Payment run not found');
  return run;
}

async function paymentRunTotal(orgId, run, client) {
  if (run.control_total != null) return String(run.control_total);
  const lines = await paymentRunsRepo.getLines(orgId, run.id, client);
  return moneyStringFromUnits(sumMoneyUnits(lines.map((line) => line.amount)));
}

async function assertNoActiveChequeForRun(orgId, paymentRunId, excludeChequeId, client) {
  if (!paymentRunId) return;
  const params = [orgId, paymentRunId];
  let exclude = '';
  if (excludeChequeId) { params.push(excludeChequeId); exclude = ` AND id<>$3`; }
  const { rows } = await client.query(
    `SELECT id, cheque_no, status FROM cheques
      WHERE organization_id=$1 AND payment_run_id=$2
        AND status NOT IN ('voided','bounced')${exclude}
      LIMIT 1`,
    params
  );
  if (rows.length) throw new AppError(409, `Payment run already has active cheque ${rows[0].cheque_no}`);
}

async function createLeaf(orgId, actorUserId, payload) {
  const bankAccountId = payload?.bankAccountId || payload?.bank_account_id;
  const chequeNo = String(payload?.chequeNo || payload?.cheque_no || '').trim();
  const currencyCode = String(payload?.currencyCode || payload?.currency_code || '').toUpperCase();
  const paymentRunId = payload?.paymentRunId || payload?.payment_run_id || null;
  if (!bankAccountId) throw new AppError(400, 'bankAccountId is required');
  if (!chequeNo) throw new AppError(400, 'chequeNo is required');
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id,currency_code,is_active FROM bank_accounts WHERE organization_id=$1 AND id=$2`, [orgId, bankAccountId]);
    if (!rows.length) throw new AppError(404, 'Bank account not found');
    if (!rows[0].is_active) throw new AppError(409, 'Inactive bank account cannot receive new cheque leaves');
    if (currencyCode && currencyCode !== rows[0].currency_code) throw new AppError(422, 'Cheque currency must match bank account currency');
    if (paymentRunId) {
      const run = await loadPaymentRunForCheque(orgId, paymentRunId, client, { lock: true });
      if (['cancelled', 'reversed'].includes(run.status)) throw new AppError(409, 'Cancelled or reversed payment runs cannot receive a cheque');
      if (String(run.bank_account_id) !== String(bankAccountId)) throw new AppError(422, 'Cheque bank account must match payment run bank account');
      if (String(run.currency_code).toUpperCase() !== String(rows[0].currency_code).toUpperCase()) throw new AppError(422, 'Cheque currency must match payment run currency');
      await assertNoActiveChequeForRun(orgId, paymentRunId, null, client);
      if (payload.amount != null && payload.amount !== '') {
        const total = await paymentRunTotal(orgId, run, client);
        if (moneyUnits(payload.amount) !== moneyUnits(total)) throw new AppError(422, `Cheque amount must equal payment run control total ${total}`);
      }
    }
    const row = await repo.create(orgId, {
      bankAccountId,
      chequeNo,
      payeeName: payload.payeeName || payload.payee_name || null,
      issueDate: payload.issueDate || payload.issue_date || null,
      amount: payload.amount != null && payload.amount !== '' ? normalizeAmount(payload.amount) : null,
      currencyCode: rows[0].currency_code,
      memo: payload.memo || null,
      paymentRunId,
    }, actorUserId, client);
    await writeAudit({ organizationId: orgId, actorUserId, action: 'CHEQUE_LEAF_CREATED', entityType: 'cheque', entityId: row.id, after: row, client });
    return row;
  });
}

async function issue(orgId, id, actorUserId, payload) {
  return withTransaction(async (client) => {
    const cheque = await repo.get(orgId, id, client, true);
    if (!cheque) throw new AppError(404, 'Cheque not found');
    if (cheque.status === 'issued') return cheque;
    if (cheque.status !== 'available') throw new AppError(409, 'Only available cheques can be issued');
    if (!cheque.bank_is_active) throw new AppError(409, 'Cheque bank account is inactive');
    const controls = await controlsSvc.get(orgId, client);
    controlsSvc.assertMakerChecker(controls, { actorUserId, createdByUserId: cheque.created_by_user_id, action: 'issue' });

    const issueDate = payload?.issueDate || payload?.issue_date || cheque.issue_date;
    const paymentRunId = payload?.paymentRunId || payload?.payment_run_id || cheque.payment_run_id || null;
    const dimensionsJson = payload?.dimensionsJson || payload?.dimensions_json || {};
    const finalAmount = payload?.amount != null ? normalizeAmount(payload.amount) : (cheque.amount != null ? normalizeAmount(cheque.amount) : null);
    if (!issueDate) throw new AppError(400, 'issueDate is required');
    if (finalAmount == null) throw new AppError(400, 'amount is required before a cheque can be issued');

    let postOnIssue = payload?.postOnIssue ?? payload?.post_on_issue ?? false;
    let offsetAccountId = payload?.offsetAccountId || payload?.offset_account_id;
    let journalEntryId = null;

    if (paymentRunId) {
      const run = await loadPaymentRunForCheque(orgId, paymentRunId, client, { lock: true });
      if (String(run.bank_account_id) !== String(cheque.bank_account_id)) throw new AppError(422, 'Cheque bank account must match payment run bank account');
      const allowed = controls.require_payment_run_approval ? ['approved', 'executed'] : ['submitted', 'approved', 'executed'];
      if (!allowed.includes(run.status)) throw new AppError(409, 'Payment run must complete its approval control before cheque issue');
      const total = await paymentRunTotal(orgId, run, client);
      if (moneyUnits(finalAmount) !== moneyUnits(total)) throw new AppError(422, `Cheque amount must equal payment run control total ${total}`);
      await assertNoActiveChequeForRun(orgId, paymentRunId, cheque.id, client);
      postOnIssue = false;
      offsetAccountId = null;
    } else if (!postOnIssue) {
      throw new AppError(409, 'Cheque issue must either be linked to a controlled payment run or post its accounting entry on issue');
    }

    if (postOnIssue) {
      if (!offsetAccountId) throw new AppError(400, 'offsetAccountId is required when postOnIssue is true');
      const { rows: coa } = await client.query(`SELECT id,is_postable,status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`, [orgId, offsetAccountId]);
      if (!coa.length) throw new AppError(404, 'Offset account not found');
      if (!coa[0].is_postable || coa[0].status !== 'active') throw new AppError(409, 'Offset account must be active and postable');
      const periodId = await findOpenPeriodId(orgId, issueDate, client);
      const posted = await journalIF.postJournal({ orgId, actorUserId, client, payload: {
        entryDate: issueDate,
        periodId,
        memo: payload?.memo || cheque.memo || `Cheque ${cheque.cheque_no}`,
        sourceType: 'cheque', sourceId: cheque.id,
        lines: [
          { accountId: offsetAccountId, debit: finalAmount, credit: '0.00', currencyCode: cheque.bank_currency_code, memo: payload?.memo || `Cheque ${cheque.cheque_no}`, dimensionsJson },
          { accountId: cheque.gl_account_id, debit: '0.00', credit: finalAmount, currencyCode: cheque.bank_currency_code, memo: `Bank outflow cheque ${cheque.cheque_no}`, dimensionsJson: {} },
        ],
      }});
      journalEntryId = posted.journalId;
    }

    const row = await repo.update(orgId, id, { status: 'issued', issueDate, amount: finalAmount, journalEntryId, memo: payload?.memo ?? cheque.memo, paymentRunId, issuedByUserId: actorUserId, issuedAt: true }, client);
    await writeAudit({ organizationId: orgId, actorUserId, action: 'CHEQUE_ISSUED', entityType: 'cheque', entityId: id, after: { status: 'issued', amount: finalAmount, journal_entry_id: journalEntryId, payment_run_id: paymentRunId }, client });
    return row;
  });
}

async function clear(orgId, id, actorUserId, payload) {
  return withTransaction(async (client) => {
    const cheque = await repo.get(orgId, id, client, true);
    if (!cheque) throw new AppError(404, 'Cheque not found');
    if (cheque.status === 'cleared') return cheque;
    if (cheque.status !== 'issued') throw new AppError(409, 'Only issued cheques can be cleared');
    const clearedDate = payload?.clearedDate || payload?.cleared_date;
    if (!clearedDate) throw new AppError(400, 'clearedDate is required');
    if (cheque.issue_date && String(clearedDate) < String(cheque.issue_date).slice(0, 10)) throw new AppError(422, 'clearedDate cannot precede issueDate');
    if (cheque.payment_run_id) {
      const run = await loadPaymentRunForCheque(orgId, cheque.payment_run_id, client, { lock: true });
      if (run.status !== 'executed') throw new AppError(409, 'A payment-run cheque cannot clear until its payment run has been executed and posted');
    } else if (!cheque.journal_entry_id) {
      throw new AppError(409, 'Cheque has no accounting posting and cannot be cleared');
    }
    const row = await repo.update(orgId, id, { status: 'cleared', clearedDate, clearedByUserId: actorUserId, clearedAt: true }, client);
    await writeAudit({ organizationId: orgId, actorUserId, action: 'CHEQUE_CLEARED', entityType: 'cheque', entityId: id, after: { status: 'cleared', cleared_date: clearedDate }, client });
    return row;
  });
}

async function reverseDirectJournal({ orgId, cheque, actorUserId, eventDate, reason, client }) {
  if (!cheque.journal_entry_id) return null;
  const periodId = await findOpenPeriodId(orgId, eventDate, client);
  const out = await journalIF.reversePostedJournal({ orgId, journalId: cheque.journal_entry_id, actorUserId, targetPeriodId: periodId, entryDate: eventDate, reason, idempotencyKey: `cheque-reversal:${cheque.id}`, client });
  return out?.reversalJournalId || out?.journalId || out?.id || null;
}

async function reverseLinkedPaymentRun({ orgId, cheque, actorUserId, eventDate, reason, client, requireExecuted = false }) {
  if (!cheque.payment_run_id) return null;
  const run = await loadPaymentRunForCheque(orgId, cheque.payment_run_id, client, { lock: true });
  if (run.status === 'reversed') return run.reversal_journal_entry_id || null;
  if (requireExecuted && run.status !== 'executed') throw new AppError(409, 'A bounced payment-run cheque requires an executed payment run');
  if (run.status !== 'executed') return null;
  if (!run.journal_entry_id) throw new AppError(409, 'Executed payment run has no journal evidence; run treasury integrity checks before reversal');
  const periodId = await findOpenPeriodId(orgId, eventDate, client);
  const out = await journalIF.reversePostedJournal({ orgId, journalId: run.journal_entry_id, actorUserId, targetPeriodId: periodId, entryDate: eventDate, reason, idempotencyKey: `cheque-payment-run-reversal:${cheque.id}:${run.id}`, client });
  const reversalJournalEntryId = out?.reversalJournalId || out?.journalId || out?.id || null;
  await paymentRunsRepo.replaceStatus(orgId, run.id, 'reversed', { reversalJournalEntryId, reversedByUserId: actorUserId, reversedAt: true, reversalReason: reason }, client);
  await writeAudit({ organizationId: orgId, actorUserId, action: 'PAYMENT_RUN_REVERSED_BY_CHEQUE', entityType: 'payment_run', entityId: run.id, before: { status: 'executed', journal_entry_id: run.journal_entry_id }, after: { status: 'reversed', reversal_journal_entry_id: reversalJournalEntryId, cheque_id: cheque.id, reason }, client });
  return reversalJournalEntryId;
}

async function reverseIfNeeded({ orgId, cheque, actorUserId, eventDate, reason, client, requireExecutedPaymentRun = false }) {
  if (cheque.payment_run_id) return reverseLinkedPaymentRun({ orgId, cheque, actorUserId, eventDate, reason, client, requireExecuted: requireExecutedPaymentRun });
  return reverseDirectJournal({ orgId, cheque, actorUserId, eventDate, reason, client });
}

async function voidCheque(orgId, id, actorUserId, payload) {
  return withTransaction(async (client) => {
    const cheque = await repo.get(orgId, id, client, true);
    if (!cheque) throw new AppError(404, 'Cheque not found');
    if (cheque.status === 'voided') return cheque;
    if (cheque.status === 'cleared') throw new AppError(409, 'Cleared cheques cannot be voided');
    const eventDate = payload?.voidDate || payload?.void_date || new Date().toISOString().slice(0, 10);
    const reason = String(payload?.reason || payload?.memo || '').trim();
    if (!reason) throw new AppError(400, 'reason is required when voiding a cheque');
    const reversalJournalEntryId = cheque.status === 'issued'
      ? await reverseIfNeeded({ orgId, cheque, actorUserId, eventDate, reason, client })
      : null;
    const row = await repo.update(orgId, id, { status: 'voided', memo: payload?.memo ?? cheque.memo, voidedByUserId: actorUserId, voidedAt: true, voidReason: reason, reversalJournalEntryId }, client);
    await writeAudit({ organizationId: orgId, actorUserId, action: 'CHEQUE_VOIDED', entityType: 'cheque', entityId: id, before: { status: cheque.status }, after: { status: 'voided', reversal_journal_entry_id: reversalJournalEntryId, reason }, client });
    return row;
  });
}

async function bounce(orgId, id, actorUserId, payload) {
  return withTransaction(async (client) => {
    const cheque = await repo.get(orgId, id, client, true);
    if (!cheque) throw new AppError(404, 'Cheque not found');
    if (cheque.status === 'bounced') return cheque;
    if (cheque.status !== 'issued') throw new AppError(409, 'Only issued cheques can be bounced');
    const eventDate = payload?.bouncedDate || payload?.bounced_date || new Date().toISOString().slice(0, 10);
    const reason = String(payload?.reason || payload?.memo || '').trim();
    if (!reason) throw new AppError(400, 'reason is required when recording a bounced cheque');
    if (!cheque.payment_run_id && !cheque.journal_entry_id) throw new AppError(409, 'Cheque has no accounting posting to reverse');
    const reversalJournalEntryId = await reverseIfNeeded({ orgId, cheque, actorUserId, eventDate, reason, client, requireExecutedPaymentRun: true });
    const row = await repo.update(orgId, id, { status: 'bounced', memo: payload?.memo ?? cheque.memo, bouncedByUserId: actorUserId, bouncedAt: true, bounceReason: reason, reversalJournalEntryId }, client);
    await writeAudit({ organizationId: orgId, actorUserId, action: 'CHEQUE_BOUNCED', entityType: 'cheque', entityId: id, before: { status: cheque.status }, after: { status: 'bounced', reversal_journal_entry_id: reversalJournalEntryId, reason }, client });
    return row;
  });
}

module.exports = { list, get, createLeaf, issue, clear, voidCheque, bounce };
