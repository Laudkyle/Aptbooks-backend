
const repo = require('./paymentRuns.repository');
const { AppError } = require('../../../../shared/errors/AppError');
const { withTransaction } = require('../../../../db/tx');
const journalIF = require('../../../../interfaces/journalPosting.interface');
const { genCode, normalizeAmount, findOpenPeriodId } = require('../_shared/helpers');

async function list(orgId, filters) { return repo.list(orgId, filters); }

async function get(orgId, paymentRunId) {
  const header = await repo.get(orgId, paymentRunId);
  if (!header) throw new AppError(404, 'Payment run not found');
  const lines = await repo.getLines(orgId, paymentRunId);
  return { ...header, lines };
}

async function create(orgId, actorUserId, payload) {
  if (!payload?.bankAccountId) throw new AppError(400, 'bankAccountId is required');
  if (!payload?.executionDate) throw new AppError(400, 'executionDate is required');
  return withTransaction(async (client) => {
    const { rows: bankRows } = await client.query(
      `SELECT id, currency_code FROM bank_accounts WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.bankAccountId]
    );
    if (!bankRows.length) throw new AppError(404, 'Bank account not found');
    const bank = bankRows[0];
    return repo.create(orgId, {
      code: payload.code || genCode('PR'),
      bankAccountId: payload.bankAccountId,
      executionDate: payload.executionDate,
      currencyCode: payload.currencyCode || bank.currency_code,
      memo: payload.memo || null,
    }, actorUserId, client);
  });
}

async function addLines(orgId, paymentRunId, payload) {
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  if (!lines.length) throw new AppError(400, 'lines[] is required');
  return withTransaction(async (client) => {
    const header = await repo.get(orgId, paymentRunId, client);
    if (!header) throw new AppError(404, 'Payment run not found');
    if (header.status !== 'draft') throw new AppError(409, 'Only draft payment runs can be edited');
    let lineNo = 1;
    const normalized = [];
    for (const line of lines) {
      if (!line.offsetAccountId) throw new AppError(400, 'offsetAccountId is required on each line');
      normalized.push({
        lineNo: lineNo++,
        partnerId: line.partnerId || null,
        payeeName: line.payeeName || null,
        sourceType: line.sourceType || null,
        sourceId: line.sourceId || null,
        offsetAccountId: line.offsetAccountId,
        description: line.description || null,
        amount: normalizeAmount(line.amount),
        currencyCode: line.currencyCode || header.currency_code,
        dimensionsJson: line.dimensionsJson || line.dimensions_json || {},
      });
    }
    return repo.addLines(orgId, paymentRunId, normalized, client);
  });
}

async function submit(orgId, paymentRunId) {
  return withTransaction(async (client) => {
    const header = await repo.get(orgId, paymentRunId, client);
    if (!header) throw new AppError(404, 'Payment run not found');
    if (header.status !== 'draft') throw new AppError(409, 'Only draft payment runs can be submitted');
    const lines = await repo.getLines(orgId, paymentRunId, client);
    if (!lines.length) throw new AppError(409, 'Cannot submit a payment run without lines');
    return repo.replaceStatus(orgId, paymentRunId, 'submitted', {}, client);
  });
}

async function approve(orgId, paymentRunId, actorUserId) {
  return withTransaction(async (client) => {
    const header = await repo.get(orgId, paymentRunId, client);
    if (!header) throw new AppError(404, 'Payment run not found');
    if (!['submitted','draft'].includes(header.status)) throw new AppError(409, 'Only draft/submitted payment runs can be approved');
    return repo.replaceStatus(orgId, paymentRunId, 'approved', { approvedByUserId: actorUserId }, client);
  });
}

async function execute(orgId, paymentRunId, actorUserId) {
  return withTransaction(async (client) => {
    const header = await repo.get(orgId, paymentRunId, client);
    if (!header) throw new AppError(404, 'Payment run not found');
    if (header.status !== 'approved') throw new AppError(409, 'Only approved payment runs can be executed');
    const lines = await repo.getLines(orgId, paymentRunId, client);
    if (!lines.length) throw new AppError(409, 'Cannot execute a payment run without lines');

    const { rows: bankRows } = await client.query(
      `SELECT id, code, name, gl_account_id, currency_code FROM bank_accounts WHERE organization_id=$1 AND id=$2`,
      [orgId, header.bank_account_id]
    );
    if (!bankRows.length) throw new AppError(404, 'Bank account not found');
    const bank = bankRows[0];

    const total = lines.reduce((sum, l) => sum + Number(l.amount || 0), 0);
    const periodId = await findOpenPeriodId(orgId, header.execution_date, client);
    const posted = await journalIF.postJournal({
      orgId,
      actorUserId,
      client,
      payload: {
        journalDate: header.execution_date,
        periodId,
        memo: header.memo || `Payment run ${header.code}`,
        sourceType: 'payment_run',
        sourceId: header.id,
        lines: [
          ...lines.map((l) => ({
            accountId: l.offset_account_id,
            debit: Number(l.amount || 0),
            credit: 0,
            currencyCode: header.currency_code || bank.currency_code,
            memo: l.description || l.payee_name || `Payment run ${header.code}`,
            dimensionsJson: l.dimensions_json || {}
          })),
          {
            accountId: bank.gl_account_id,
            debit: 0,
            credit: total,
            currencyCode: bank.currency_code,
            memo: `Bank outflow for payment run ${header.code}`,
            dimensionsJson: {}
          }
        ]
      }
    });
    return repo.replaceStatus(orgId, paymentRunId, 'executed', {
      periodId,
      journalEntryId: posted.journalId,
      executedByUserId: actorUserId,
    }, client);
  });
}

async function cancel(orgId, paymentRunId, reason) {
  return withTransaction(async (client) => {
    const header = await repo.get(orgId, paymentRunId, client);
    if (!header) throw new AppError(404, 'Payment run not found');
    if (header.status === 'executed') throw new AppError(409, 'Executed payment runs cannot be cancelled');
    return repo.replaceStatus(orgId, paymentRunId, 'cancelled', { cancelledReason: reason || null }, client);
  });
}

module.exports = { list, get, create, addLines, submit, approve, execute, cancel };
