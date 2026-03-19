
const repo = require('./cheques.repository');
const { AppError } = require('../../../../shared/errors/AppError');
const { withTransaction } = require('../../../../db/tx');
const journalIF = require('../../../../interfaces/journalPosting.interface');
const { normalizeAmount, findOpenPeriodId } = require('../_shared/helpers');

async function list(orgId, filters) { return repo.list(orgId, filters); }
async function get(orgId, chequeId) {
  const row = await repo.get(orgId, chequeId);
  if (!row) throw new AppError(404, 'Cheque not found');
  return row;
}

async function createLeaf(orgId, actorUserId, payload) {
  const bankAccountId = payload?.bankAccountId || payload?.bank_account_id;
  const chequeNo = payload?.chequeNo || payload?.cheque_no;
  const issueDate = payload?.issueDate || payload?.issue_date;
  const currencyCode = payload?.currencyCode || payload?.currency_code;
  const paymentRunId = payload?.paymentRunId || payload?.payment_run_id;
  const journalEntryId = payload?.journalEntryId || payload?.journal_entry_id;
  if (!bankAccountId) throw new AppError(400, 'bankAccountId is required');
  if (!chequeNo) throw new AppError(400, 'chequeNo is required');
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id, currency_code FROM bank_accounts WHERE organization_id=$1 AND id=$2`, [orgId, bankAccountId]);
    if (!rows.length) throw new AppError(404, 'Bank account not found');
    return repo.create(orgId, {
      bankAccountId,
      chequeNo,
      payeeName: payload.payeeName || payload.payee_name || null,
      issueDate: issueDate || null,
      amount: payload.amount != null ? normalizeAmount(payload.amount) : null,
      currencyCode: currencyCode || rows[0].currency_code,
      status: payload.status || 'available',
      memo: payload.memo || null,
      paymentRunId: paymentRunId || null,
      journalEntryId: journalEntryId || null,
    }, actorUserId, client);
  });
}

async function issue(orgId, chequeId, actorUserId, payload) {
  return withTransaction(async (client) => {
    const cheque = await repo.get(orgId, chequeId, client);
    if (!cheque) throw new AppError(404, 'Cheque not found');
    if (!['available'].includes(cheque.status)) throw new AppError(409, 'Only available cheques can be issued');
    const postOnIssue = payload?.postOnIssue ?? payload?.post_on_issue;
    const offsetAccountId = payload?.offsetAccountId || payload?.offset_account_id;
    const issueDate = payload?.issueDate || payload?.issue_date || cheque.issue_date;
    const paymentRunId = payload?.paymentRunId || payload?.payment_run_id || null;
    const dimensionsJson = payload?.dimensionsJson || payload?.dimensions_json || {};
    const finalAmount = payload?.amount != null ? normalizeAmount(payload.amount) : (cheque.amount != null ? normalizeAmount(cheque.amount) : null);
    if (!issueDate) throw new AppError(400, 'issueDate is required');
    if (finalAmount == null) throw new AppError(400, 'amount is required before a cheque can be issued');
    let journalEntryId = cheque.journal_entry_id || null;
    if (postOnIssue) {
      if (!offsetAccountId) throw new AppError(400, 'offsetAccountId is required when postOnIssue is true');
      const { rows } = await client.query(`SELECT gl_account_id, currency_code FROM bank_accounts WHERE organization_id=$1 AND id=$2`, [orgId, cheque.bank_account_id]);
      if (!rows.length) throw new AppError(404, 'Bank account not found');
      const bank = rows[0];
      const periodId = await findOpenPeriodId(orgId, issueDate, client);
      const posted = await journalIF.postJournal({
        orgId,
        actorUserId,
        client,
        payload: {
          entryDate: issueDate,
          periodId,
          memo: payload?.memo || cheque.memo || `Cheque ${cheque.cheque_no}`,
          sourceType: 'cheque',
          sourceId: cheque.id,
          lines: [
            { accountId: offsetAccountId, debit: Number(finalAmount || 0), credit: 0, currencyCode: cheque.currency_code || bank.currency_code, memo: payload?.memo || `Cheque ${cheque.cheque_no}`, dimensionsJson },
            { accountId: bank.gl_account_id, debit: 0, credit: Number(finalAmount || 0), currencyCode: bank.currency_code, memo: `Bank outflow cheque ${cheque.cheque_no}`, dimensionsJson: {} }
          ]
        }
      });
      journalEntryId = posted.journalId;
    }
    return repo.update(orgId, chequeId, {
      status: 'issued',
      issueDate,
      amount: finalAmount,
      journalEntryId,
      memo: payload?.memo || null,
      paymentRunId
    }, client);
  });
}

async function clear(orgId, chequeId, payload) {
  return withTransaction(async (client) => {
    const cheque = await repo.get(orgId, chequeId, client);
    if (!cheque) throw new AppError(404, 'Cheque not found');
    if (cheque.status !== 'issued') throw new AppError(409, 'Only issued cheques can be cleared');
    const clearedDate = payload?.clearedDate || payload?.cleared_date;
    if (!clearedDate) throw new AppError(400, 'clearedDate is required');
    return repo.update(orgId, chequeId, { status: 'cleared', clearedDate }, client);
  });
}

async function voidCheque(orgId, chequeId, payload) {
  return withTransaction(async (client) => {
    const cheque = await repo.get(orgId, chequeId, client);
    if (!cheque) throw new AppError(404, 'Cheque not found');
    if (cheque.status === 'cleared') throw new AppError(409, 'Cleared cheques cannot be voided');
    return repo.update(orgId, chequeId, { status: 'voided', memo: payload?.memo || cheque.memo }, client);
  });
}

async function bounce(orgId, chequeId, payload) {
  return withTransaction(async (client) => {
    const cheque = await repo.get(orgId, chequeId, client);
    if (!cheque) throw new AppError(404, 'Cheque not found');
    if (cheque.status !== 'issued') throw new AppError(409, 'Only issued cheques can be bounced');
    return repo.update(orgId, chequeId, { status: 'bounced', memo: payload?.memo || cheque.memo }, client);
  });
}

module.exports = { list, get, createLeaf, issue, clear, voidCheque, bounce };
