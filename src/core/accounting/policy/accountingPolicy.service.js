const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const { writeAudit } = require('../../foundation/audit-logs/audit.service');
const { DEFAULT_ACCOUNTING_POLICY, normalizePolicy, assertSupportedPolicy } = require('./accountingPolicy');
const repository = require('./accountingPolicy.repository');

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    version: Number(row.version_no),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
    ...normalizePolicy(row),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function ensureDefaultPolicy({ orgId, actorUserId = null, client = pool }) {
  await repository.ensureDefault({ client, orgId, actorUserId, policy: DEFAULT_ACCOUNTING_POLICY });
}

async function getEffectivePolicy({ orgId, asOfDate, actorUserId = null, client = pool }) {
  if (!orgId) throw new AppError(400, 'organization is required', null, 'organization_required');
  const date = asOfDate || new Date().toISOString().slice(0, 10);
  let row = await repository.findEffective({ client, orgId, asOfDate: date });
  if (!row) {
    await ensureDefaultPolicy({ orgId, actorUserId, client });
    row = await repository.findVersionOne({ client, orgId });
  }
  if (!row) throw new AppError(500, 'Accounting policy could not be resolved', null, 'accounting_policy_missing');
  try {
    const policy = assertSupportedPolicy(row);
    return { ...toApi(row), ...policy };
  } catch (error) {
    throw new AppError(409, error.message, { field: error.field }, 'unsupported_accounting_policy');
  }
}

async function listPolicyVersions({ orgId, client = pool }) {
  return (await repository.listVersions({ client, orgId })).map(toApi);
}

async function createPolicyVersion({ orgId, actorUserId, payload, client: existingClient = null }) {
  const client = existingClient || await pool.connect();
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query('BEGIN');
    let policy;
    try { policy = assertSupportedPolicy(payload || {}); }
    catch (error) { throw new AppError(422, error.message, { field: error.field }, 'unsupported_accounting_policy'); }
    const effectiveFrom = payload.effectiveFrom || payload.effective_from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveFrom || ''))) {
      throw new AppError(422, 'effectiveFrom must be YYYY-MM-DD', { field: 'effectiveFrom' }, 'validation_error');
    }

    const previous = await repository.lockLatestVersion({ client, orgId });
    const nextVersion = previous ? Number(previous.version_no) + 1 : 1;
    if (previous && String(effectiveFrom) <= String(previous.effective_from).slice(0, 10)) {
      throw new AppError(409, 'A new accounting policy must become effective after the latest published policy version',
        { latestEffectiveFrom: previous.effective_from }, 'accounting_policy_effective_date_conflict');
    }

    const latestPosting = await repository.latestPostedEntryDate({ client, orgId });
    const latestEntryDate = latestPosting?.latest_entry_date;
    if (latestEntryDate && String(effectiveFrom) <= String(latestEntryDate).slice(0, 10)) {
      throw new AppError(409, 'Accounting policy versions cannot be introduced retroactively across posted financial history',
        { latestPostedEntryDate: latestEntryDate }, 'accounting_policy_retroactive_change');
    }

    const row = await repository.insertVersion({ client, orgId, actorUserId, effectiveFrom, version: nextVersion, policy });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'accounting.policy.version_created',
      entityType: 'accounting_policy_versions', entityId: row.id, after: toApi(row), client });
    if (managesTx) await client.query('COMMIT');
    return toApi(row);
  } catch (error) {
    if (managesTx) { try { await client.query('ROLLBACK'); } catch (_) {} }
    if (error instanceof AppError) throw error;
    if (error.code === '23P01' || error.code === '23505') {
      throw new AppError(409, 'Accounting policy version conflicts with an existing effective date or version', null, 'accounting_policy_overlap');
    }
    throw error;
  } finally {
    if (managesTx) client.release();
  }
}

module.exports = { ensureDefaultPolicy, getEffectivePolicy, listPolicyVersions, createPolicyVersion };
