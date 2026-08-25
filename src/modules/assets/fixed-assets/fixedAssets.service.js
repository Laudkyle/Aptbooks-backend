const repo = require("./fixedAssets.repository");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const journalIF = require("../../../interfaces/journalPosting.interface");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");
const {
  moneyUnits, moneyStringFromUnits, sumMoneyUnits, absUnits, assetBookAmounts, moneyNumber,
} = require("../../../shared/utils/financialMath");

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}

async function loadAssetBookState({ orgId, asset, client = null }) {
  const database = client || pool;
  const [{ rows: depRows }, { rows: revaluationRows }] = await Promise.all([
    database.query(`SELECT COALESCE(SUM(amount),0)::numeric AS amt FROM asset_depreciation_transactions WHERE organization_id=$1 AND asset_id=$2`, [orgId, asset.id]),
    database.query(`SELECT payload_json FROM asset_events WHERE organization_id=$1 AND asset_id=$2 AND event_type='revaluation' ORDER BY event_date, created_at`, [orgId, asset.id]),
  ]);
  let revaluationDeltaUnits = 0n;
  for (const row of revaluationRows) {
    const payload = row.payload_json || {};
    if (payload.delta != null) revaluationDeltaUnits += moneyUnits(payload.delta);
    else if (payload.newValue != null && payload.priorValue != null) revaluationDeltaUnits += moneyUnits(payload.newValue) - moneyUnits(payload.priorValue);
  }
  return assetBookAmounts({ cost: asset.cost || '0', accumulatedDepreciation: depRows[0]?.amt || '0',
    revaluationDelta: moneyStringFromUnits(revaluationDeltaUnits), impairmentTotal: asset.impairment_total || '0' });
}

async function assertCategoryExists({ orgId, categoryId, client = null }) {
  const { rows } = await (client || pool).query(`SELECT id, status FROM asset_categories WHERE organization_id=$1 AND id=$2`, [orgId, categoryId]);
  if (!rows.length) throw new AppError(400, "Invalid categoryId");
  if (rows[0].status !== "active") throw new AppError(409, "Category is inactive");
}

async function createAsset({ orgId, actorUserId, payload, audit = {} }) {
  return withTransaction(async (client) => {
    await assertCategoryExists({ orgId, categoryId: payload.categoryId, client });
    if (moneyUnits(payload.salvageValue || "0") > moneyUnits(payload.cost)) throw new AppError(422, "Residual value cannot exceed asset cost");
    const created = await repo.createAsset({ orgId, payload, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'create', entityType: 'fixed_asset', entityId: created.id,
      ip: audit.ip, userAgent: audit.userAgent, before: null, after: created, client });
    return created;
  });
}

async function listAssets({ orgId, query }) { return repo.listAssets({ orgId, query }); }
async function listDimensionOptions({ orgId }) { return repo.listDimensionOptions({ orgId }); }
async function getOverview({ orgId }) { return repo.overview({ orgId }); }

async function createDimension({ orgId, actorUserId, payload, audit = {} }) {
  return withTransaction(async (client) => {
    const created = await repo.createDimension({ orgId, type: payload.type, code: payload.code, name: payload.name, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'create', entityType: `asset_${payload.type}`, entityId: created.id,
      ip: audit.ip, userAgent: audit.userAgent, before: null, after: created, client });
    return created;
  });
}

async function getAssetDetails({ orgId, assetId }) {
  const asset = await repo.getAssetWithCategoryAccounts({ orgId, assetId });
  if (!asset) throw new AppError(404, "Asset not found");
  const book = await loadAssetBookState({ orgId, asset });
  const [{ rows: schedules }, { rows: events }, { rows: documents }] = await Promise.all([
    pool.query(`SELECT * FROM asset_depreciation_schedules WHERE organization_id=$1 AND asset_id=$2 ORDER BY effective_start_date DESC, created_at DESC`, [orgId, assetId]),
    pool.query(`SELECT * FROM asset_events WHERE organization_id=$1 AND asset_id=$2 ORDER BY event_date DESC, created_at DESC`, [orgId, assetId]),
    pool.query(`SELECT l.document_id, d.title, d.entity_type, d.description, l.created_at
                  FROM asset_document_links l JOIN documents d ON d.id=l.document_id
                 WHERE l.organization_id=$1 AND l.asset_id=$2 ORDER BY l.created_at DESC`, [orgId, assetId]),
  ]);
  return { asset, accumulatedDepreciation: moneyNumber(moneyStringFromUnits(book.accumulatedUnits)),
    book: { grossBookValue: moneyStringFromUnits(book.grossBookUnits), accumulatedDepreciation: moneyStringFromUnits(book.accumulatedUnits),
      carryingAmount: moneyStringFromUnits(book.carryingUnits), impairmentTotal: asset.impairment_total || '0.00' },
    schedules, events, documents };
}

async function updateAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  return withTransaction(async (client) => {
    const before = await repo.getAsset({ orgId, assetId, client, forUpdate: true });
    if (!before) throw new AppError(404, "Asset not found");
    if (payload.categoryId) await assertCategoryExists({ orgId, categoryId: payload.categoryId, client });
    if (before.status !== "draft") {
      const forbidden = ["cost", "salvageValue", "acquisitionDate", "categoryId"].some((key) => payload[key] !== undefined);
      if (forbidden) throw new AppError(409, "Cost, residual value, acquisition date and category are locked after acquisition");
    }
    const nextCost = payload.cost ?? before.cost;
    const nextResidual = payload.salvageValue ?? before.salvage_value;
    if (moneyUnits(nextResidual || '0') > moneyUnits(nextCost || '0')) throw new AppError(422, "Residual value cannot exceed asset cost");
    const nextAcquisition = payload.acquisitionDate ?? before.acquisition_date;
    const nextService = Object.prototype.hasOwnProperty.call(payload, 'inServiceDate') ? payload.inServiceDate : before.in_service_date;
    if (nextService && nextService < nextAcquisition) throw new AppError(422, "In-service date cannot be before acquisition date");
    const updated = await repo.updateAsset({ orgId, assetId, payload, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'update', entityType: 'fixed_asset', entityId: assetId,
      ip: audit.ip, userAgent: audit.userAgent, before, after: updated, client });
    return updated;
  });
}

async function deleteDraftAsset({ orgId, actorUserId, assetId, audit = {} }) {
  return withTransaction(async (client) => {
    const before = await repo.getAsset({ orgId, assetId, client, forUpdate: true });
    if (!before) throw new AppError(404, "Asset not found");
    if (before.status !== 'draft') throw new AppError(409, "Only draft assets can be deleted");
    const deleted = await repo.deleteDraftAsset({ orgId, assetId, client });
    if (!deleted) throw new AppError(409, "Only draft assets can be deleted");
    await writeAudit({ organizationId: orgId, actorUserId, action: 'delete', entityType: 'fixed_asset', entityId: assetId,
      ip: audit.ip, userAgent: audit.userAgent, before, after: null, client });
    return { deleted: true, id: assetId };
  });
}

async function transferAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  return withTransaction(async (client) => {
    const before = await repo.getAsset({ orgId, assetId, client, forUpdate: true });
    if (!before) throw new AppError(404, "Asset not found");
    if (!['active','retired'].includes(before.status)) throw new AppError(409, "Only active or retired assets can be transferred");
    const updated = await repo.updateAsset({ orgId, assetId, payload: {
      locationId: payload.toLocationId, departmentId: payload.toDepartmentId, costCenterId: payload.toCostCenterId,
    }, client });
    await repo.insertAssetEvent({ orgId, assetId, eventType: 'transfer', eventDate: payload.eventDate, reference: payload.reference,
      memo: payload.memo, payloadJson: { from: { locationId: before.location_id, departmentId: before.department_id, costCenterId: before.cost_center_id },
        to: { locationId: payload.toLocationId, departmentId: payload.toDepartmentId, costCenterId: payload.toCostCenterId } }, createdBy: actorUserId, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'transfer', entityType: 'fixed_asset', entityId: assetId,
      ip: audit.ip, userAgent: audit.userAgent, before, after: updated, client });
    return updated;
  });
}

async function revalueAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  return withTransaction(async (client) => {
    const asset = await repo.getAssetWithCategoryAccounts({ orgId, assetId, client, forUpdate: true });
    if (!asset) throw new AppError(404, "Asset not found");
    if (asset.status !== 'active') throw new AppError(409, "Only active assets can be revalued");
    const book = await loadAssetBookState({ orgId, asset, client });
    const baseValueUnits = book.carryingUnits;
    const newValueUnits = moneyUnits(payload.newValue);
    const deltaUnits = newValueUnits - baseValueUnits;
    if (newValueUnits < 0n) throw new AppError(422, 'Revalued carrying amount cannot be negative');
    if (deltaUnits === 0n) throw new AppError(409, "No change in value");
    if (!asset.asset_account_id) throw new AppError(409, 'Category missing asset account');
    const baseValue = moneyStringFromUnits(baseValueUnits);
    const newValue = moneyStringFromUnits(newValueUnits);
    const delta = moneyStringFromUnits(deltaUnits);
    const deltaAbs = moneyStringFromUnits(absUnits(deltaUnits));
    const lines = deltaUnits > 0n
      ? [{ accountId: asset.asset_account_id, debit: deltaAbs, credit: '0.00', description: 'Asset revaluation increase' },
         { accountId: payload.revaluationReserveAccountId, debit: '0.00', credit: deltaAbs, description: 'Revaluation reserve' }]
      : [{ accountId: payload.revaluationReserveAccountId, debit: deltaAbs, credit: '0.00', description: 'Revaluation reserve decrease' },
         { accountId: asset.asset_account_id, debit: '0.00', credit: deltaAbs, description: 'Asset revaluation decrease' }];
    const posted = await journalIF.postSourceJournal({ orgId, actorUserId, client, sourceType: 'fixed_asset', sourceId: assetId,
      sourceAction: 'revalue', sourceReference: asset.code, sourceModule: 'assets', payload: {
        periodId: payload.periodId, entryDate: payload.entryDate, typeCode: 'GENERAL',
        memo: payload.memo || `Asset revaluation: ${asset.code} - ${asset.name}`,
        idempotencyKey: `asset-rev:${orgId}:${assetId}:${payload.periodId}:${payload.entryDate}`, lines } });
    const updated = await repo.updateCurrentValue({ orgId, assetId, currentValue: newValue, impairmentTotal: null,
      lastRevaluationAt: payload.entryDate, client });
    await repo.insertAssetEvent({ orgId, assetId, eventType: 'revaluation', eventDate: payload.entryDate, memo: payload.memo || null,
      payloadJson: { priorValue: baseValue, newValue, delta, journalId: posted.journalId, periodId: payload.periodId }, createdBy: actorUserId, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'revalue', entityType: 'fixed_asset', entityId: assetId,
      ip: audit.ip, userAgent: audit.userAgent, before: asset, after: updated, client });
    return { asset: updated, journalId: posted.journalId, delta: moneyNumber(delta) };
  });
}

async function impairAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  return withTransaction(async (client) => {
    const asset = await repo.getAssetWithCategoryAccounts({ orgId, assetId, client, forUpdate: true });
    if (!asset) throw new AppError(404, "Asset not found");
    if (asset.status !== 'active') throw new AppError(409, "Only active assets can be impaired");
    if (!asset.asset_account_id) throw new AppError(409, 'Category missing asset account');
    const book = await loadAssetBookState({ orgId, asset, client });
    const amountUnits = moneyUnits(payload.impairmentAmount);
    if (amountUnits <= 0n) throw new AppError(422, 'Impairment amount must be greater than zero');
    if (amountUnits > book.carryingUnits) throw new AppError(409, 'Impairment amount exceeds current carrying amount');
    const amount = moneyStringFromUnits(amountUnits);
    const baseValue = moneyStringFromUnits(book.carryingUnits);
    const newValue = moneyStringFromUnits(book.carryingUnits - amountUnits);
    const posted = await journalIF.postSourceJournal({ orgId, actorUserId, client, sourceType: 'fixed_asset', sourceId: assetId,
      sourceAction: 'impair', sourceReference: asset.code, sourceModule: 'assets', payload: {
        periodId: payload.periodId, entryDate: payload.entryDate, typeCode: 'GENERAL',
        memo: payload.memo || `Asset impairment: ${asset.code} - ${asset.name}`,
        idempotencyKey: `asset-imp:${orgId}:${assetId}:${payload.periodId}:${payload.entryDate}`,
        lines: [
          { accountId: payload.impairmentLossAccountId, debit: amount, credit: '0.00', description: 'Impairment loss' },
          { accountId: asset.asset_account_id, debit: '0.00', credit: amount, description: 'Asset impairment' },
        ] } });
    const updated = await repo.updateCurrentValue({ orgId, assetId, currentValue: newValue,
      impairmentTotal: moneyStringFromUnits(book.impairmentUnits + amountUnits), lastRevaluationAt: null, client });
    await repo.insertAssetEvent({ orgId, assetId, eventType: 'impairment', eventDate: payload.entryDate, memo: payload.memo || null,
      payloadJson: { priorValue: baseValue, impairmentAmount: amount, newValue, journalId: posted.journalId, periodId: payload.periodId }, createdBy: actorUserId, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'impair', entityType: 'fixed_asset', entityId: assetId,
      ip: audit.ip, userAgent: audit.userAgent, before: asset, after: updated, client });
    return { asset: updated, journalId: posted.journalId, impairmentAmount: moneyNumber(amount) };
  });
}

async function acquireAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  return withTransaction(async (client) => {
    const asset = await repo.getAssetWithCategoryAccounts({ orgId, assetId, client, forUpdate: true });
    if (!asset) throw new AppError(404, "Asset not found");
    if (asset.status !== 'draft') {
      if (asset.acquisition_journal_entry_id) return { asset, journalId: asset.acquisition_journal_entry_id, idempotent: true };
      throw new AppError(409, 'Only draft assets can be acquired');
    }
    if (asset.category_status !== 'active') throw new AppError(409, 'Asset category is inactive');
    const costUnits = moneyUnits(asset.cost || '0');
    if (costUnits <= 0n) throw new AppError(409, 'Asset cost must be greater than zero to acquire');
    if (!asset.asset_account_id) throw new AppError(409, 'Category missing asset account');
    const cost = moneyStringFromUnits(costUnits);
    const posted = await journalIF.postSourceJournal({ orgId, actorUserId, client, sourceType: 'fixed_asset', sourceId: assetId,
      sourceAction: 'acquire', sourceReference: asset.code, sourceModule: 'assets', payload: {
        periodId: payload.periodId, entryDate: payload.entryDate, typeCode: 'GENERAL',
        memo: payload.memo || `Asset acquisition: ${asset.code} - ${asset.name}`,
        idempotencyKey: `asset-acq:${orgId}:${assetId}`,
        lines: [
          { accountId: asset.asset_account_id, debit: cost, credit: '0.00', description: 'Asset acquisition' },
          { accountId: payload.fundingAccountId, debit: '0.00', credit: cost, description: 'Funding source' },
        ] } });
    const updated = await repo.markAcquired({ orgId, assetId, actorUserId, journalId: posted.journalId,
      memo: payload.memo || null, entryDate: payload.entryDate, client });
    if (!updated) throw new AppError(409, 'Asset acquisition state changed concurrently');
    await repo.insertAssetEvent({ orgId, assetId, eventType: 'acquisition', eventDate: payload.entryDate,
      memo: payload.memo || null, payloadJson: { journalId: posted.journalId, periodId: payload.periodId, cost }, createdBy: actorUserId, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'acquire', entityType: 'fixed_asset', entityId: assetId,
      ip: audit.ip, userAgent: audit.userAgent, before: asset, after: updated, client });
    return { asset: updated, journalId: posted.journalId, idempotent: !!posted.idempotent };
  });
}

async function retireAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  return withTransaction(async (client) => {
    const before = await repo.getAsset({ orgId, assetId, client, forUpdate: true });
    if (!before) throw new AppError(404, 'Asset not found');
    if (before.status === 'retired') return before;
    if (before.status !== 'active') throw new AppError(409, 'Only active assets can be retired');
    const updated = await repo.updateStatus({ orgId, assetId, status: 'retired', tsField: 'retired_at', reason: payload.reason, client });
    await repo.insertAssetEvent({ orgId, assetId, eventType: 'retirement', eventDate: payload.eventDate,
      memo: payload.reason, payloadJson: { priorStatus: before.status }, createdBy: actorUserId, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'retire', entityType: 'fixed_asset', entityId: assetId,
      ip: audit.ip, userAgent: audit.userAgent, before, after: updated, client });
    return updated;
  });
}

async function disposeAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  return withTransaction(async (client) => {
    const asset = await repo.getAssetWithCategoryAccounts({ orgId, assetId, client, forUpdate: true });
    if (!asset) throw new AppError(404, 'Asset not found');
    if (asset.status === 'disposed' && asset.disposal_journal_entry_id) return { asset, journalId: asset.disposal_journal_entry_id, idempotent: true };
    if (!['active','retired'].includes(asset.status)) throw new AppError(409, 'Only active or retired assets can be disposed');
    if (asset.category_status !== 'active') throw new AppError(409, 'Asset category is inactive');
    const { asset_account_id: assetAcc, accum_depr_account_id: accumAcc,
      disposal_gain_account_id: gainAcc, disposal_loss_account_id: lossAcc } = asset;
    if (!assetAcc || !accumAcc || !gainAcc || !lossAcc) throw new AppError(409, 'Asset category is missing one or more disposal posting accounts');
    const proceedsUnits = moneyUnits(payload.proceeds || '0');
    const proceeds = moneyStringFromUnits(proceedsUnits);
    const book = await loadAssetBookState({ orgId, asset, client });
    const grossBookUnits = book.grossBookUnits;
    const accumulatedUnits = book.accumulatedUnits;
    const carryingUnits = book.carryingUnits;
    if (carryingUnits < 0n) throw new AppError(409, 'Asset register has a negative carrying amount; run asset integrity checks before disposal');
    const gainLossUnits = proceedsUnits - carryingUnits;
    const lines = [];
    if (proceedsUnits > 0n) lines.push({ accountId: payload.proceedsAccountId, debit: proceeds, credit: '0.00', description: 'Disposal proceeds' });
    if (accumulatedUnits > 0n) lines.push({ accountId: accumAcc, debit: moneyStringFromUnits(accumulatedUnits), credit: '0.00', description: 'Clear accumulated depreciation' });
    if (grossBookUnits > 0n) lines.push({ accountId: assetAcc, debit: '0.00', credit: moneyStringFromUnits(grossBookUnits), description: 'Derecognize asset carrying basis' });
    if (gainLossUnits > 0n) lines.push({ accountId: gainAcc, debit: '0.00', credit: moneyStringFromUnits(gainLossUnits), description: 'Gain on disposal' });
    if (gainLossUnits < 0n) lines.push({ accountId: lossAcc, debit: moneyStringFromUnits(absUnits(gainLossUnits)), credit: '0.00', description: 'Loss on disposal' });
    const debitUnits = sumMoneyUnits(lines.map((line) => line.debit || '0'));
    const creditUnits = sumMoneyUnits(lines.map((line) => line.credit || '0'));
    if (debitUnits !== creditUnits) throw new AppError(500, 'Disposal journal is not balanced');
    const posted = await journalIF.postSourceJournal({ orgId, actorUserId, client, sourceType: 'fixed_asset', sourceId: assetId,
      sourceAction: 'dispose', sourceReference: asset.code, sourceModule: 'assets', payload: {
        periodId: payload.periodId, entryDate: payload.entryDate, typeCode: 'GENERAL',
        memo: payload.memo || `Asset disposal: ${asset.code} - ${asset.name}`,
        idempotencyKey: `asset-disp:${orgId}:${assetId}`, lines } });
    const updated = await repo.markDisposed({ orgId, assetId, actorUserId, journalId: posted.journalId,
      entryDate: payload.entryDate, proceeds, memo: payload.memo || null, client });
    if (!updated) throw new AppError(409, 'Asset disposal state changed concurrently');
    await repo.insertAssetEvent({ orgId, assetId, eventType: 'disposal', eventDate: payload.entryDate, memo: payload.memo || null,
      payloadJson: { journalId: posted.journalId, periodId: payload.periodId, proceeds,
        grossBookValue: moneyStringFromUnits(grossBookUnits), accumulatedDepreciation: moneyStringFromUnits(accumulatedUnits),
        carryingAmount: moneyStringFromUnits(carryingUnits), gainLoss: moneyStringFromUnits(gainLossUnits) }, createdBy: actorUserId, client });
    await writeAudit({ organizationId: orgId, actorUserId, action: 'dispose', entityType: 'fixed_asset', entityId: assetId,
      ip: audit.ip, userAgent: audit.userAgent, before: asset, after: updated, client });
    return { asset: updated, journalId: posted.journalId, idempotent: !!posted.idempotent,
      computed: { grossBookValue: moneyNumber(moneyStringFromUnits(grossBookUnits)), accumulated: moneyNumber(moneyStringFromUnits(accumulatedUnits)),
        nbv: moneyNumber(moneyStringFromUnits(carryingUnits)), proceeds: moneyNumber(proceeds), gainLoss: moneyNumber(moneyStringFromUnits(gainLossUnits)) } };
  });
}

module.exports = {
  createAsset, listAssets, listDimensionOptions, createDimension, getOverview, getAssetDetails, updateAsset,
  deleteDraftAsset, transferAsset, revalueAsset, impairAsset, acquireAsset, retireAsset, disposeAsset,
};
