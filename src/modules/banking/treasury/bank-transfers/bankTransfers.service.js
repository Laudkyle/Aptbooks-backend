
const repo = require('./bankTransfers.repository');
const { AppError } = require('../../../../shared/errors/AppError');
const { withTransaction } = require('../../../../db/tx');
const journalIF = require('../../../../interfaces/journalPosting.interface');
const { genCode, normalizeAmount, parseOptionalAmount, findOpenPeriodId } = require('../_shared/helpers');

async function list(orgId, filters) { return repo.list(orgId, filters); }
async function get(orgId, bankTransferId) {
  const out = await repo.get(orgId, bankTransferId);
  if (!out) throw new AppError(404, 'Bank transfer not found');
  return out;
}

async function create(orgId, actorUserId, payload) {
  const fromBankAccountId = payload?.fromBankAccountId || payload?.from_bank_account_id;
  const toBankAccountId = payload?.toBankAccountId || payload?.to_bank_account_id;
  const transferDate = payload?.transferDate || payload?.transfer_date;
  const feeAmount = payload?.feeAmount ?? payload?.fee_amount;
  const feeAccountId = payload?.feeAccountId || payload?.fee_account_id;
  if (!fromBankAccountId) throw new AppError(400, 'fromBankAccountId is required');
  if (!toBankAccountId) throw new AppError(400, 'toBankAccountId is required');
  if (!transferDate) throw new AppError(400, 'transferDate is required');
  if (fromBankAccountId === toBankAccountId) throw new AppError(400, 'fromBankAccountId and toBankAccountId must differ');
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM bank_accounts WHERE organization_id=$1 AND id = ANY($2::uuid[])`,
      [orgId, [fromBankAccountId, toBankAccountId]]
    );
    if (rows.length !== 2) throw new AppError(404, 'One or more bank accounts were not found');
    return repo.create(orgId, {
      code: payload.code || genCode('BT'),
      fromBankAccountId,
      toBankAccountId,
      transferDate,
      amount: normalizeAmount(payload.amount),
      feeAmount: parseOptionalAmount(feeAmount, 'feeAmount'),
      feeAccountId: feeAccountId || null,
      reference: payload.reference || null,
      memo: payload.memo || null,
    }, actorUserId, client);
  });
}

async function submit(orgId, bankTransferId) {
  return withTransaction(async (client) => {
    const row = await repo.get(orgId, bankTransferId, client);
    if (!row) throw new AppError(404, 'Bank transfer not found');
    if (row.status !== 'draft') throw new AppError(409, 'Only draft bank transfers can be submitted');
    return repo.updateStatus(orgId, bankTransferId, 'submitted', {}, client);
  });
}

async function approve(orgId, bankTransferId, actorUserId) {
  return withTransaction(async (client) => {
    const row = await repo.get(orgId, bankTransferId, client);
    if (!row) throw new AppError(404, 'Bank transfer not found');
    if (!['draft','submitted'].includes(row.status)) throw new AppError(409, 'Only draft/submitted bank transfers can be approved');
    return repo.updateStatus(orgId, bankTransferId, 'approved', { approvedByUserId: actorUserId }, client);
  });
}

async function post(orgId, bankTransferId, actorUserId) {
  return withTransaction(async (client) => {
    const row = await repo.get(orgId, bankTransferId, client);
    if (!row) throw new AppError(404, 'Bank transfer not found');
    if (row.status !== 'approved') throw new AppError(409, 'Only approved bank transfers can be posted');

    const { rows: banks } = await client.query(
      `SELECT id, code, name, gl_account_id, currency_code FROM bank_accounts WHERE organization_id=$1 AND id = ANY($2::uuid[])`,
      [orgId, [row.from_bank_account_id, row.to_bank_account_id]]
    );
    if (banks.length !== 2) throw new AppError(404, 'One or more bank accounts were not found');
    const fromBank = banks.find((b) => b.id === row.from_bank_account_id);
    const toBank = banks.find((b) => b.id === row.to_bank_account_id);

    const periodId = await findOpenPeriodId(orgId, row.transfer_date, client);
    const lines = [
      {
        accountId: toBank.gl_account_id,
        debit: Number(row.amount || 0),
        credit: 0,
        currencyCode: toBank.currency_code,
        memo: `Transfer in ${row.code}`,
        dimensionsJson: {}
      },
      {
        accountId: fromBank.gl_account_id,
        debit: 0,
        credit: Number(row.amount || 0) + Number(row.fee_amount || 0),
        currencyCode: fromBank.currency_code,
        memo: `Transfer out ${row.code}`,
        dimensionsJson: {}
      }
    ];
    if (Number(row.fee_amount || 0) > 0) {
      if (!row.fee_account_id) throw new AppError(400, 'feeAccountId is required when feeAmount is greater than zero');
      lines.splice(1, 0, {
        accountId: row.fee_account_id,
        debit: Number(row.fee_amount || 0),
        credit: 0,
        currencyCode: fromBank.currency_code,
        memo: `Transfer fee ${row.code}`,
        dimensionsJson: {}
      });
    }
    const posted = await journalIF.postJournal({
      orgId,
      actorUserId,
      client,
      payload: {
        entryDate: row.transfer_date,
        periodId,
        memo: row.memo || `Bank transfer ${row.code}`,
        sourceType: 'bank_transfer',
        sourceId: row.id,
        lines
      }
    });
    return repo.updateStatus(orgId, bankTransferId, 'posted', { periodId, journalEntryId: posted.journalId, postedByUserId: actorUserId }, client);
  });
}

async function cancel(orgId, bankTransferId, reason) {
  return withTransaction(async (client) => {
    const row = await repo.get(orgId, bankTransferId, client);
    if (!row) throw new AppError(404, 'Bank transfer not found');
    if (row.status === 'posted') throw new AppError(409, 'Posted bank transfers cannot be cancelled');
    return repo.updateStatus(orgId, bankTransferId, 'cancelled', { cancelledReason: reason || null }, client);
  });
}

module.exports = { list, get, create, submit, approve, post, cancel };
