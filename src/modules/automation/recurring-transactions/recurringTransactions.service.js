const repo = require('./recurringTransactions.repository');
const { AppError } = require('../../../shared/errors/AppError');
const journalApi = require('../../../interfaces/journalPosting.interface');
const { getJournalWithLines } = require('../../../interfaces/journalPosting.interface');
const { resolvePeriodIdForDate, normalizeEntryDate } = require('../automation.helpers');
const { withTransaction } = require('../../../db/tx');

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function computeNextRunDate(def, runDate) {
  const base = normalizeEntryDate(runDate);
  if (def.schedule_type === 'daily') return addDays(base, 1);
  if (def.schedule_type === 'weekly') return addDays(base, 7);
  if (def.schedule_type === 'interval_days') return addDays(base, def.interval_days || 1);
  if (def.schedule_type === 'monthly') {
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const day = Number(def.day_of_month || d.getUTCDate());
    d.setUTCDate(Math.min(day, 28));
    return d.toISOString().slice(0, 10);
  }
  return addDays(base, 1);
}

async function buildPayloadFromTemplate(orgId, def, runDate) {
  const entryDate = normalizeEntryDate(runDate);
  if (def.source_type === 'journal_id' && def.source_journal_id) {
    const tmpl = await getJournalWithLines({ orgId, journalId: def.source_journal_id });
    return {
      memo: tmpl.journal.memo || `Recurring ${def.name}`,
      typeCode: null,
      entryDate,
      periodId: tmpl.journal.period_id,
      lines: (tmpl.lines || []).map((l) => ({
        accountId: l.account_id,
        debit: l.debit,
        credit: l.credit,
        description: l.description,
        currencyCode: l.currency_code,
        fxRate: l.fx_rate,
      }))
    };
  }
  const payload = def.journal_payload || {};
  const out = { ...payload, entryDate };
  if (!out.periodId) out.periodId = await resolvePeriodIdForDate(orgId, entryDate);
  if (!Array.isArray(out.lines) || !out.lines.length) throw new AppError(400, 'Recurring transaction requires journalPayload.lines');
  return out;
}

async function list(orgId) {
  return { data: await repo.list(orgId) };
}

async function getOne(orgId, id) {
  const row = await repo.getById(orgId, id);
  if (!row) throw new AppError(404, 'Recurring transaction not found');
  return { data: row };
}

async function create(orgId, actorUserId, payload) {
  if (!payload?.code) throw new AppError(400, 'code is required');
  if (!payload?.name) throw new AppError(400, 'name is required');
  if (!payload?.scheduleType) throw new AppError(400, 'scheduleType is required');
  if (!payload?.startDate) throw new AppError(400, 'startDate is required');
  const nextRunDate = payload.nextRunDate || payload.startDate;
  const created = await repo.create(orgId, actorUserId, { ...payload, nextRunDate });
  return { data: created };
}

async function update(orgId, id, actorUserId, payload) {
  const updated = await repo.update(orgId, id, actorUserId, payload || {});
  if (!updated) throw new AppError(404, 'Recurring transaction not found');
  return { data: updated };
}

async function runNow(orgId, actorUserId, id, payload = {}) {
  return withTransaction(async (client) => {
    const def = await repo.getById(orgId, id, client);
    if (!def) throw new AppError(404, 'Recurring transaction not found');
    const runDate = normalizeEntryDate(payload.runDate || new Date().toISOString().slice(0, 10));
    const journalPayload = await buildPayloadFromTemplate(orgId, def, runDate);
    let result;
    if (def.auto_post) {
      result = await journalApi.postJournal({ orgId, actorUserId, payload: journalPayload, client });
    } else {
      result = await journalApi.createDraftJournal({ orgId, actorUserId, payload: journalPayload, client });
    }
    const journalEntryId = result?.journalId || result?.journalEntryId || null;
    const run = await repo.recordRun(orgId, id, {
      runDate,
      status: def.auto_post ? 'posted' : 'drafted',
      journalEntryId,
      message: def.auto_post ? 'Recurring journal posted' : 'Recurring journal drafted',
      payloadSnapshot: journalPayload,
      resultSnapshot: result
    }, client);
    const nextRunDate = computeNextRunDate(def, runDate);
    await repo.markExecuted(orgId, id, nextRunDate, client);
    return { data: { recurringTransaction: def, run, result, nextRunDate } };
  });
}

async function listRuns(orgId, id) {
  const def = await repo.getById(orgId, id);
  if (!def) throw new AppError(404, 'Recurring transaction not found');
  return { data: await repo.listRuns(orgId, id) };
}

async function runDueRecurringTransactions({ orgId = null, actorUserId = null, asOfDate = null } = {}) {
  const runDate = normalizeEntryDate(asOfDate || new Date().toISOString().slice(0, 10));
  const due = await repo.listDue(orgId, runDate);
  let processed = 0;
  for (const item of due) {
    try {
      await runNow(item.organization_id, actorUserId, item.id, { runDate });
      processed += 1;
    } catch (_) {}
  }
  return { message: `Processed ${processed} recurring transaction(s)`, processed };
}

module.exports = { list, getOne, create, update, runNow, listRuns, runDueRecurringTransactions };
