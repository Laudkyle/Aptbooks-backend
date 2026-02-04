const { pool } = require('../../../db/pool');
const { withTransaction } = require('../../../db/tx');
const { AppError } = require('../../../shared/errors/AppError');
const periodIF = require('../../../interfaces/periodManagement.interface');
const partnerIF = require('../../../interfaces/partnerManagement.interface');
const journalIF = require('../../../interfaces/journalPosting.interface');

const repo = require('./writeoffs.repository');

async function listReasonCodes({ orgId }) {
  const client = await pool.connect();
  try { return await repo.listReasonCodes({ orgId, client }); } finally { client.release(); }
}
async function upsertReasonCode({ orgId, payload }) {
  return withTransaction(async (client) => repo.upsertReasonCode({ orgId, payload, client }));
}
async function deleteReasonCode({ orgId, code }) {
  return withTransaction(async (client) => repo.deleteReasonCode({ orgId, code, client }));
}

async function getSettings({ orgId }) {
  const client = await pool.connect();
  try { return await repo.getSettings({ orgId, client }); } finally { client.release(); }
}
async function upsertSettings({ orgId, payload }) {
  return withTransaction(async (client) => repo.upsertSettings({ orgId, payload, client }));
}

async function listWriteoffs({ orgId, status }) {
  const client = await pool.connect();
  try { return await repo.listWriteoffs({ orgId, status, client }); } finally { client.release(); }
}
async function getWriteoff({ orgId, id }) {
  const client = await pool.connect();
  try { return await repo.getWriteoff({ orgId, id, client }); } finally { client.release(); }
}

async function createDraft({ orgId, actorUserId, payload }) {
  return withTransaction(async (client) => repo.createWriteoff({ orgId, actorUserId, payload, client }));
}

async function submit({ orgId, id, actorUserId }) {
  return withTransaction(async (client) => repo.setStatus({ orgId, id, status: 'submitted', actorUserId, action: 'submitted', client }));
}

async function approve({ orgId, id, actorUserId }) {
  return withTransaction(async (client) => repo.setStatus({ orgId, id, status: 'approved', actorUserId, action: 'approved', client }));
}

async function reject({ orgId, id, actorUserId, reason }) {
  return withTransaction(async (client) => repo.setStatus({ orgId, id, status: 'rejected', actorUserId, action: 'rejected', payload: { reason: reason || null }, client }));
}

async function voidWriteoff({ orgId, id, actorUserId }) {
  return withTransaction(async (client) => repo.setStatus({ orgId, id, status: 'void', actorUserId, action: 'voided', client }));
}

async function post({ orgId, id, actorUserId, postingDate, memo }) {
  return withTransaction(async (client) => {
    const wo = await repo.getWriteoff({ orgId, id, client });
    if (wo.status !== 'approved') throw new AppError(400, 'Write-off must be approved before posting');

    const settings = await repo.getSettings({ orgId, client });
    if (!settings) throw new AppError(400, 'Write-off settings not configured');

    const postDate = postingDate || new Date().toISOString().slice(0,10);
    const period = await periodIF.getOpenPeriodForDate({ orgId, date: postDate, client });

    if (wo.entity_type === 'invoice') {
      if (!settings.ar_bad_debt_expense_account_id) throw new AppError(400, 'Missing AR bad debt expense account in write-off settings');

      const inv = await repo.getInvoiceForWriteoff({ orgId, invoiceId: wo.entity_id, client });
      const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: inv.customer_id });
      if (!customer.default_receivable_account_id) throw new AppError(400, 'Customer missing default receivable account');

      const lines = [
        { account_id: settings.ar_bad_debt_expense_account_id, debit: wo.amount, credit: 0 },
        { account_id: customer.default_receivable_account_id, debit: 0, credit: wo.amount }
      ];
      const journal = await journalIF.postJournal({
        orgId,
        periodId: period.id,
        journal_date: postDate,
        memo: memo || `Write-off invoice ${inv.invoice_no || inv.id}`,
        source_type: 'writeoff',
        source_id: wo.id,
        lines,
        client
      });
      await repo.markPosted({ orgId, id: wo.id, journalId: journal.id, actorUserId, client });
    } else {
      if (!settings.ap_writeoff_income_account_id) throw new AppError(400, 'Missing AP write-off income account in write-off settings');

      const bill = await repo.getBillForWriteoff({ orgId, billId: wo.entity_id, client });
      const vendor = await partnerIF.getActiveVendorForOrg({ orgId, vendorId: bill.vendor_id });
      if (!vendor.default_payable_account_id) throw new AppError(400, 'Vendor missing default payable account');

      const lines = [
        { account_id: vendor.default_payable_account_id, debit: wo.amount, credit: 0 },
        { account_id: settings.ap_writeoff_income_account_id, debit: 0, credit: wo.amount }
      ];
      const journal = await journalIF.postJournal({
        orgId,
        periodId: period.id,
        journal_date: postDate,
        memo: memo || `Write-off bill ${bill.bill_no || bill.id}`,
        source_type: 'writeoff',
        source_id: wo.id,
        lines,
        client
      });
      await repo.markPosted({ orgId, id: wo.id, journalId: journal.id, actorUserId, client });
    }

    return repo.getWriteoff({ orgId, id: wo.id, client });
  });
}

module.exports = {
  listReasonCodes,
  upsertReasonCode,
  deleteReasonCode,
  getSettings,
  upsertSettings,
  listWriteoffs,
  getWriteoff,
  createDraft,
  submit,
  approve,
  reject,
  voidWriteoff,
  post
};
