const crypto = require('crypto');
const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const journalSvc = require('../journal/journal.service');
const policySvc = require('../policy/accountingPolicy.service');
const { normalizePostingLines, postingFingerprint } = require('./postingInvariants');

function normalizeSource(source = {}) {
  return {
    type: source.type || source.sourceType || null,
    id: source.id || source.sourceId || null,
    action: source.action || source.sourceAction || 'post',
    reference: source.reference || source.sourceReference || null,
    module: source.module || source.sourceModule || null,
  };
}

function toAppError(error) {
  if (error instanceof AppError) return error;
  if (error?.code === 'journal_not_balanced') {
    return new AppError(422, error.message, null, 'journal_not_balanced');
  }
  if (String(error?.code || '').startsWith('posting_') || error?.code === 'invalid_posting_line') {
    return new AppError(422, error.message, null, error.code);
  }
  return error;
}

async function claimIdempotency({ client, orgId, idempotencyKey, fingerprint, source }) {
  if (!idempotencyKey) return null;
  const normalizedSource = normalizeSource(source);
  const { rows: inserted } = await client.query(
    `INSERT INTO accounting_posting_requests
       (organization_id, idempotency_key, request_fingerprint, source_type, source_id, source_action, source_reference, source_module)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [orgId, idempotencyKey, fingerprint, normalizedSource.type, normalizedSource.id,
      normalizedSource.action, normalizedSource.reference, normalizedSource.module]
  );
  if (inserted.length) return { ...inserted[0], isNew: true };

  const { rows: existing } = await client.query(
    `SELECT * FROM accounting_posting_requests
      WHERE organization_id=$1 AND idempotency_key=$2
      FOR UPDATE`,
    [orgId, idempotencyKey]
  );
  const claim = existing[0];
  if (!claim || claim.request_fingerprint !== fingerprint) {
    throw new AppError(409, 'Idempotency key was already used for a different financial command', {
      idempotencyKey,
    }, 'financial_idempotency_conflict');
  }
  return { ...claim, isNew: false };
}

async function bindClaimToJournal({ client, orgId, idempotencyKey, journalId }) {
  if (!idempotencyKey) return;
  await client.query(
    `UPDATE accounting_posting_requests
     SET journal_entry_id=COALESCE(journal_entry_id,$3)
     WHERE organization_id=$1 AND idempotency_key=$2`,
    [orgId, idempotencyKey, journalId]
  );
  const { rows } = await client.query(
    `SELECT journal_entry_id FROM accounting_posting_requests WHERE organization_id=$1 AND idempotency_key=$2`,
    [orgId, idempotencyKey]
  );
  if (rows[0]?.journal_entry_id && String(rows[0].journal_entry_id) !== String(journalId)) {
    throw new AppError(409, 'Idempotency key is bound to a different journal', null, 'financial_idempotency_conflict');
  }
}

async function loadJournalSnapshot(client, { orgId, journalId }) {
  const { rows: journals } = await client.query(
    `SELECT id, period_id, entry_date, memo, status, idempotency_key
     FROM journal_entries WHERE organization_id=$1 AND id=$2`, [orgId, journalId]);
  if (!journals.length) throw new AppError(404, 'Journal not found', null, 'journal_not_found');
  const { rows: lines } = await client.query(
    `SELECT line_no, account_id, description, debit, credit, currency_code, fx_rate, amount_base
     FROM journal_entry_lines WHERE journal_entry_id=$1 ORDER BY line_no`, [journalId]);
  return { journal: journals[0], lines };
}

async function recordPostingProvenance({ client, orgId, journalId, actorUserId, source, policy, fingerprint }) {
  const normalizedSource = normalizeSource(source);
  const { rows } = await client.query(
    `INSERT INTO journal_posting_provenance
       (organization_id, journal_entry_id, accounting_policy_version_id, posting_fingerprint,
        source_type, source_id, source_action, source_reference, source_module, posted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (journal_entry_id) DO NOTHING
     RETURNING id`,
    [orgId, journalId, policy.id, fingerprint, normalizedSource.type, normalizedSource.id,
      normalizedSource.action, normalizedSource.reference, normalizedSource.module, actorUserId]
  );
  if (!rows.length) {
    const { rows: existing } = await client.query(
      `SELECT posting_fingerprint, accounting_policy_version_id FROM journal_posting_provenance
       WHERE organization_id=$1 AND journal_entry_id=$2`, [orgId, journalId]);
    if (existing.length && existing[0].posting_fingerprint !== fingerprint) {
      throw new AppError(409, 'Posted journal provenance does not match the current draft snapshot', null, 'posting_provenance_conflict');
    }
  }
}

async function createDraftJournal({ orgId, actorUserId, payload, client: existingClient = null, source = null }) {
  const client = existingClient || await pool.connect();
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query('BEGIN');
    const normalizedPayload = { ...(payload || {}), entryDate: payload?.entryDate || payload?.journalDate || null };
    const fingerprint = postingFingerprint({ orgId, source: source || normalizedPayload.source || {}, payload: normalizedPayload });
    await claimIdempotency({ client, orgId, idempotencyKey: normalizedPayload.idempotencyKey, fingerprint, source: source || normalizedPayload.source });
    const result = await journalSvc.createDraftJournal({ orgId, actorUserId, payload: normalizedPayload, client });
    await bindClaimToJournal({ client, orgId, idempotencyKey: normalizedPayload.idempotencyKey, journalId: result.journalId });
    if (managesTx) await client.query('COMMIT');
    return result;
  } catch (error) {
    if (managesTx) { try { await client.query('ROLLBACK'); } catch (_) {} }
    throw toAppError(error);
  } finally {
    if (managesTx) client.release();
  }
}

async function postDraftJournal({ orgId, journalId, actorUserId, client: existingClient = null, sourceApproval = null, source = null, idempotencyKey = null }) {
  const client = existingClient || await pool.connect();
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query('BEGIN');
    const snapshot = await loadJournalSnapshot(client, { orgId, journalId });
    normalizePostingLines(snapshot.lines.map((line) => ({
      accountId: line.account_id, description: line.description, debit: line.debit, credit: line.credit,
      currencyCode: line.currency_code, fxRate: line.fx_rate,
    })), { requireBalanced: false });
    const effectiveSource = source || (idempotencyKey
      ? { type: 'journal', id: journalId, action: 'post', reference: journalId, module: 'accounting' }
      : {});
    const fingerprint = postingFingerprint({ orgId, source: effectiveSource, payload: {
      periodId: snapshot.journal.period_id,
      entryDate: snapshot.journal.entry_date,
      memo: snapshot.journal.memo,
      idempotencyKey: idempotencyKey || snapshot.journal.idempotency_key,
      lines: snapshot.lines.map((line) => ({ accountId: line.account_id, description: line.description,
        debit: line.debit, credit: line.credit, currencyCode: line.currency_code, fxRate: line.fx_rate })),
    }});
    const claim = await claimIdempotency({ client, orgId, idempotencyKey, fingerprint, source: effectiveSource });
    if (claim && !claim.isNew && claim.journal_entry_id && String(claim.journal_entry_id) === String(journalId)
        && ['posted', 'voided'].includes(snapshot.journal.status)) {
      const policy = await policySvc.getEffectivePolicy({ orgId, asOfDate: snapshot.journal.entry_date, actorUserId, client });
      if (managesTx) await client.query('COMMIT');
      return { journalId, status: snapshot.journal.status, idempotent: true,
        accountingPolicyVersionId: policy.id, accountingPolicyVersion: policy.version };
    }
    await bindClaimToJournal({ client, orgId, idempotencyKey, journalId });
    const policy = await policySvc.getEffectivePolicy({ orgId, asOfDate: snapshot.journal.entry_date, actorUserId, client });
    await recordPostingProvenance({ client, orgId, journalId, actorUserId, source: effectiveSource, policy, fingerprint });
    const result = await journalSvc.postDraftJournal({ orgId, journalId, actorUserId, client, sourceApproval });
    if (managesTx) await client.query('COMMIT');
    return { ...result, accountingPolicyVersionId: policy.id, accountingPolicyVersion: policy.version };
  } catch (error) {
    if (managesTx) { try { await client.query('ROLLBACK'); } catch (_) {} }
    throw toAppError(error);
  } finally {
    if (managesTx) client.release();
  }
}

async function postJournal({ orgId, actorUserId, payload, client: existingClient = null, source = null }) {
  const client = existingClient || await pool.connect();
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query('BEGIN');
    const normalizedPayload = { ...(payload || {}), entryDate: payload?.entryDate || payload?.journalDate || null };
    normalizedPayload.lines = normalizePostingLines(normalizedPayload.lines || [], { requireBalanced: false });
    const draft = await createDraftJournal({ orgId, actorUserId, payload: normalizedPayload, client, source });
    if (draft.idempotent && ['posted', 'voided'].includes(draft.status)) {
      const snapshot = await loadJournalSnapshot(client, { orgId, journalId: draft.journalId });
      const policy = await policySvc.getEffectivePolicy({ orgId, asOfDate: snapshot.journal.entry_date, actorUserId, client });
      if (managesTx) await client.query('COMMIT');
      return { journalId: draft.journalId, status: draft.status, idempotent: true,
        accountingPolicyVersionId: policy.id, accountingPolicyVersion: policy.version };
    }
    const result = await postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client, source });
    if (managesTx) await client.query('COMMIT');
    return result;
  } catch (error) {
    if (managesTx) { try { await client.query('ROLLBACK'); } catch (_) {} }
    throw toAppError(error);
  } finally {
    if (managesTx) client.release();
  }
}

async function postSourceJournal({ orgId, actorUserId, sourceType, sourceId, sourceAction = 'post', sourceReference = null, sourceModule = null, payload, client = null }) {
  if (!sourceType || !sourceId) throw new AppError(422, 'sourceType and sourceId are required for source posting', null, 'posting_source_required');
  return postJournal({ orgId, actorUserId, payload, client, source: {
    type: sourceType, id: sourceId, action: sourceAction, reference: sourceReference, module: sourceModule,
  }});
}

async function recordReversalProvenance({ client, orgId, originalJournalId, reversalJournalId, actorUserId, action, reason }) {
  const snapshot = await loadJournalSnapshot(client, { orgId, journalId: reversalJournalId });
  const source = { type: 'journal', id: originalJournalId, action, reference: originalJournalId, module: 'accounting' };
  const fingerprint = postingFingerprint({ orgId, source, payload: {
    periodId: snapshot.journal.period_id,
    entryDate: snapshot.journal.entry_date,
    memo: snapshot.journal.memo,
    lines: snapshot.lines.map((line) => ({ accountId: line.account_id, description: line.description,
      debit: line.debit, credit: line.credit, currencyCode: line.currency_code, fxRate: line.fx_rate })),
    reversalReason: reason || null,
  }});
  const policy = await policySvc.getEffectivePolicy({ orgId, asOfDate: snapshot.journal.entry_date, actorUserId, client });
  await recordPostingProvenance({ client, orgId, journalId: reversalJournalId, actorUserId, source, policy, fingerprint });
}

async function voidPostedJournal({ orgId, journalId, actorUserId, reason, client: existingClient = null }) {
  const client = existingClient || await pool.connect();
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query('BEGIN');
    const result = await journalSvc.voidByReversal({ orgId, journalId, actorUserId, reason, client });
    await recordReversalProvenance({ client, orgId, originalJournalId: journalId,
      reversalJournalId: result.reversalJournalId, actorUserId, action: 'void_reversal', reason });
    if (managesTx) await client.query('COMMIT');
    return result;
  } catch (error) {
    if (managesTx) { try { await client.query('ROLLBACK'); } catch (_) {} }
    throw toAppError(error);
  } finally { if (managesTx) client.release(); }
}

async function reversePostedJournal({ orgId, journalId, actorUserId, targetPeriodId, entryDate, reason, idempotencyKey, client: existingClient = null }) {
  const client = existingClient || await pool.connect();
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query('BEGIN');
    const source = { type: 'journal', id: journalId, action: 'reversal', reference: journalId, module: 'accounting' };
    const commandFingerprint = postingFingerprint({ orgId, source, payload: { periodId: targetPeriodId, entryDate,
      idempotencyKey, memo: reason || null, lines: [] } });
    await claimIdempotency({ client, orgId, idempotencyKey, fingerprint: commandFingerprint, source });
    const result = await journalSvc.reversePostedJournal({ orgId, journalId, actorUserId, targetPeriodId, entryDate, reason, idempotencyKey, client });
    await bindClaimToJournal({ client, orgId, idempotencyKey, journalId: result.reversalJournalId });
    await recordReversalProvenance({ client, orgId, originalJournalId: journalId,
      reversalJournalId: result.reversalJournalId, actorUserId, action: 'reversal', reason });
    if (managesTx) await client.query('COMMIT');
    return result;
  } catch (error) {
    if (managesTx) { try { await client.query('ROLLBACK'); } catch (_) {} }
    throw toAppError(error);
  } finally { if (managesTx) client.release(); }
}

async function batchPostJournals({ orgId, actorUserId, journalIds, client: existingClient = null, idempotencyKey = null }) {
  const ids = Array.from(new Set(journalIds || []));
  if (!ids.length) throw new AppError(422, 'journalIds is required', null, 'validation_error');
  const client = existingClient || await pool.connect();
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query('BEGIN');
    const results = [];
    for (const journalId of ids) {
      const childIdempotencyKey = idempotencyKey
        ? `batch:${crypto.createHash('sha256').update(`${idempotencyKey}|${journalId}`).digest('hex')}`
        : null;
      results.push(await postDraftJournal({ orgId, journalId, actorUserId, client, idempotencyKey: childIdempotencyKey,
        source: { type: 'journal_batch', id: journalId, action: 'post', module: 'accounting' } }));
    }
    if (managesTx) await client.query('COMMIT');
    return { count: results.length, results };
  } catch (error) {
    if (managesTx) { try { await client.query('ROLLBACK'); } catch (_) {} }
    throw toAppError(error);
  } finally { if (managesTx) client.release(); }
}

module.exports = {
  createDraftJournal,
  postDraftJournal,
  postJournal,
  postSourceJournal,
  voidPostedJournal,
  reversePostedJournal,
  batchPostJournals,
  normalizeSource,
};
