const repo = require("./fixedAssets.repository");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const journalIF = require("../../../interfaces/journalPosting.interface");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");
const {
  moneyUnits,
  moneyStringFromUnits,
  sumMoneyUnits,
  absUnits,
  assetBookAmounts,
  moneyNumber,
} = require("../../../shared/utils/financialMath");

async function loadAssetBookState({ orgId, asset }) {
  const [{ rows: depRows }, { rows: revaluationRows }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS amt
       FROM asset_depreciation_transactions
       WHERE organization_id=$1 AND asset_id=$2`,
      [orgId, asset.id]
    ),
    pool.query(
      `SELECT payload_json
       FROM asset_events
       WHERE organization_id=$1 AND asset_id=$2 AND event_type='revaluation'
       ORDER BY event_date, created_at`,
      [orgId, asset.id]
    ),
  ]);

  let revaluationDeltaUnits = 0n;
  for (const row of revaluationRows) {
    const payload = row.payload_json || {};
    if (payload.delta != null) {
      revaluationDeltaUnits += moneyUnits(payload.delta);
    } else if (payload.newValue != null && payload.priorValue != null) {
      // Compatibility for any legacy event that omitted the explicit delta.
      revaluationDeltaUnits += moneyUnits(payload.newValue) - moneyUnits(payload.priorValue);
    }
  }

  return assetBookAmounts({
    cost: asset.cost || '0',
    accumulatedDepreciation: depRows[0]?.amt || '0',
    revaluationDelta: moneyStringFromUnits(revaluationDeltaUnits),
    impairmentTotal: asset.impairment_total || '0',
  });
}

async function assertCategoryExists({ orgId, categoryId }) {
  const { rows } = await pool.query(
    `SELECT id, status FROM asset_categories WHERE organization_id=$1 AND id=$2`,
    [orgId, categoryId]
  );
  if (!rows.length) throw new AppError(400, "Invalid categoryId");
  if (rows[0].status !== "active") throw new AppError(409, "Category is inactive");
}

async function createAsset({ orgId, actorUserId, payload }) {
  await assertCategoryExists({ orgId, categoryId: payload.categoryId });
  if (moneyUnits(payload.salvageValue || "0") > moneyUnits(payload.cost)) {
    throw new AppError(400, "salvageValue cannot exceed cost");
  }
  // Creation is metadata-only. Operational acquisition is performed via /:id/acquire.
  return repo.createAsset({ orgId, payload });
}

async function listAssets({ orgId, query }) {
  return repo.listAssets({ orgId, query });
}

async function listDimensionOptions({ orgId }) {
  return repo.listDimensionOptions({ orgId });
}

async function getAssetDetails({ orgId, assetId }) {
  const asset = await repo.getAssetWithCategoryAccounts({ orgId, assetId });
  if (!asset) throw new AppError(404, "Asset not found");

  const { rows: depSum } = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS amt FROM asset_depreciation_transactions WHERE organization_id=$1 AND asset_id=$2`,
    [orgId, assetId]
  );
  const accumulatedDepreciation = moneyNumber(depSum[0].amt || "0");

  const { rows: schedules } = await pool.query(
    `SELECT * FROM asset_depreciation_schedules WHERE organization_id=$1 AND asset_id=$2 ORDER BY effective_start_date DESC, created_at DESC`,
    [orgId, assetId]
  );
  const { rows: events } = await pool.query(
    `SELECT * FROM asset_events WHERE organization_id=$1 AND asset_id=$2 ORDER BY event_date DESC, created_at DESC`,
    [orgId, assetId]
  );
  const { rows: documents } = await pool.query(
    `SELECT l.document_id, d.title, d.entity_type, d.description, l.created_at
     FROM asset_document_links l
     JOIN documents d ON d.id=l.document_id
     WHERE l.organization_id=$1 AND l.asset_id=$2
     ORDER BY l.created_at DESC`,
    [orgId, assetId]
  );

  return { asset, accumulatedDepreciation, schedules, events, documents };
}

async function updateAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  const before = await repo.getAsset({ orgId, assetId });
  if (!before) throw new AppError(404, "Asset not found");

  if (payload.categoryId) await assertCategoryExists({ orgId, categoryId: payload.categoryId });

  // Cost/salvage changes only allowed while draft (enterprise control)
  if (before.status !== "draft") {
    const forbidden = ["cost", "salvageValue", "acquisitionDate"].some((k) => payload[k] !== undefined);
    if (forbidden) throw new AppError(409, "Only draft assets can have cost/salvage/acquisitionDate updated");
  }
  if (payload.salvageValue !== undefined && payload.cost !== undefined) {
    if (moneyUnits(payload.salvageValue) > moneyUnits(payload.cost)) throw new AppError(400, "salvageValue cannot exceed cost");
  }
  if (payload.salvageValue !== undefined && payload.cost === undefined) {
    if (moneyUnits(payload.salvageValue) > moneyUnits(before.cost)) throw new AppError(400, "salvageValue cannot exceed cost");
  }
  if (payload.cost !== undefined && payload.salvageValue === undefined) {
    if (moneyUnits(before.salvage_value || "0") > moneyUnits(payload.cost)) throw new AppError(400, "salvageValue cannot exceed cost");
  }

  const updated = await repo.updateAsset({ orgId, assetId, payload });
  if (!updated) throw new AppError(404, "Asset not found");

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "update",
    entityType: "fixed_asset",
    entityId: assetId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before,
    after: updated,
  });

  return updated;
}

async function deleteDraftAsset({ orgId, actorUserId, assetId, audit = {} }) {
  const before = await repo.getAsset({ orgId, assetId });
  if (!before) throw new AppError(404, "Asset not found");
  if (before.status !== "draft") throw new AppError(409, "Only draft assets can be deleted");
  const deleted = await repo.deleteDraftAsset({ orgId, assetId });
  if (!deleted) throw new AppError(409, "Only draft assets can be deleted");
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "delete",
    entityType: "fixed_asset",
    entityId: assetId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before,
    after: null,
  });
  return { deleted: true, id: assetId };
}

async function transferAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  const before = await repo.getAsset({ orgId, assetId });
  if (!before) throw new AppError(404, "Asset not found");
  if (before.status !== "active" && before.status !== "retired") {
    throw new AppError(409, "Only active or retired assets can be transferred");
  }
  const updated = await repo.updateAsset({
    orgId,
    assetId,
    payload: {
      locationId: payload.toLocationId,
      departmentId: payload.toDepartmentId,
      costCenterId: payload.toCostCenterId,
    },
  });
  await repo.insertAssetEvent({
    orgId,
    assetId,
    eventType: "transfer",
    eventDate: payload.eventDate,
    reference: payload.reference,
    memo: payload.memo,
    payloadJson: {
      from: { locationId: before.location_id, departmentId: before.department_id, costCenterId: before.cost_center_id },
      to: { locationId: payload.toLocationId, departmentId: payload.toDepartmentId, costCenterId: payload.toCostCenterId },
    },
    createdBy: actorUserId,
  });
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "transfer",
    entityType: "fixed_asset",
    entityId: assetId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before,
    after: updated,
  });
  return updated;
}

async function revalueAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  const asset = await repo.getAssetWithCategoryAccounts({ orgId, assetId });
  if (!asset) throw new AppError(404, "Asset not found");
  if (asset.status !== "active") throw new AppError(409, "Only active assets can be revalued");

  const book = await loadAssetBookState({ orgId, asset });
  const baseValueCents = book.carryingUnits;
  const newValueCents = moneyUnits(payload.newValue);
  const deltaCents = newValueCents - baseValueCents;
  if (deltaCents === 0n) throw new AppError(409, "No change in value");
  const baseValue = moneyStringFromUnits(baseValueCents);
  const newValue = moneyStringFromUnits(newValueCents);
  const delta = moneyStringFromUnits(deltaCents);
  if (!asset.asset_account_id) throw new AppError(409, "Category missing asset_account_id");

  const reserveAcc = payload.revaluationReserveAccountId;

  const lines = [];
  const deltaAbs = moneyStringFromUnits(absUnits(deltaCents));
  if (deltaCents > 0n) {
    lines.push({ accountId: asset.asset_account_id, debit: deltaAbs, credit: "0.00", description: "Asset revaluation increase" });
    lines.push({ accountId: reserveAcc, debit: "0.00", credit: deltaAbs, description: "Asset revaluation reserve" });
  } else {
    lines.push({ accountId: reserveAcc, debit: deltaAbs, credit: "0.00", description: "Asset revaluation reserve" });
    lines.push({ accountId: asset.asset_account_id, debit: "0.00", credit: deltaAbs, description: "Asset revaluation decrease" });
  }

  const idemKey = `asset-rev:${orgId}:${assetId}:${payload.periodId}:${payload.entryDate}`;
  const draft = await journalIF.createDraftJournal({
    orgId,
    actorUserId,
    payload: {
      periodId: payload.periodId,
      entryDate: payload.entryDate,
      typeCode: "GENERAL",
      memo: payload.memo || `Asset revaluation: ${asset.code} - ${asset.name}`,
      idempotencyKey: idemKey,
      lines,
    },
  });
  const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId });

  const updated = await repo.updateCurrentValue({
    orgId,
    assetId,
    currentValue: newValue,
    impairmentTotal: null,
    lastRevaluationAt: payload.entryDate,
  });

  await repo.insertAssetEvent({
    orgId,
    assetId,
    eventType: "revaluation",
    eventDate: payload.entryDate,
    reference: null,
    memo: payload.memo || null,
    payloadJson: { priorValue: baseValue, newValue, delta, journalId: posted.journalId, periodId: payload.periodId },
    createdBy: actorUserId,
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "revalue",
    entityType: "fixed_asset",
    entityId: assetId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before: asset,
    after: updated,
  });

  return { asset: updated, journalId: posted.journalId, delta: moneyNumber(delta) };
}

async function impairAsset({ orgId, actorUserId, assetId, payload, audit = {} }) {
  const asset = await repo.getAssetWithCategoryAccounts({ orgId, assetId });
  if (!asset) throw new AppError(404, "Asset not found");
  if (asset.status !== "active") throw new AppError(409, "Only active assets can be impaired");
  if (!asset.asset_account_id) throw new AppError(409, "Category missing asset_account_id");

  const book = await loadAssetBookState({ orgId, asset });
  const baseValueCents = book.carryingUnits;
  const impairmentTotalCents = book.impairmentUnits;
  const amountCents = moneyUnits(payload.impairmentAmount);
  if (amountCents <= 0n) throw new AppError(400, "impairmentAmount must be > 0");
  if (amountCents > baseValueCents) throw new AppError(409, "impairmentAmount exceeds current carrying value");
  const baseValue = moneyStringFromUnits(baseValueCents);
  const amount = moneyStringFromUnits(amountCents);

  const lines = [
    { accountId: payload.impairmentLossAccountId, debit: amount, credit: "0.00", description: "Impairment loss" },
    { accountId: asset.asset_account_id, debit: "0.00", credit: amount, description: "Asset impairment" },
  ];

  const idemKey = `asset-imp:${orgId}:${assetId}:${payload.periodId}:${payload.entryDate}`;
  const draft = await journalIF.createDraftJournal({
    orgId,
    actorUserId,
    payload: {
      periodId: payload.periodId,
      entryDate: payload.entryDate,
      typeCode: "GENERAL",
      memo: payload.memo || `Asset impairment: ${asset.code} - ${asset.name}`,
      idempotencyKey: idemKey,
      lines,
    },
  });
  const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId });

  const updatedValueCents = baseValueCents - amountCents;
  const updatedValue = moneyStringFromUnits(updatedValueCents);
  const updated = await repo.updateCurrentValue({
    orgId,
    assetId,
    currentValue: updatedValue,
    impairmentTotal: moneyStringFromUnits(impairmentTotalCents + amountCents),
    lastRevaluationAt: null,
  });

  await repo.insertAssetEvent({
    orgId,
    assetId,
    eventType: "impairment",
    eventDate: payload.entryDate,
    reference: null,
    memo: payload.memo || null,
    payloadJson: { priorValue: baseValue, impairmentAmount: amount, newValue: updatedValue, journalId: posted.journalId, periodId: payload.periodId },
    createdBy: actorUserId,
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "impair",
    entityType: "fixed_asset",
    entityId: assetId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    before: asset,
    after: updated,
  });

  return { asset: updated, journalId: posted.journalId, impairmentAmount: moneyNumber(amount) };
}

async function acquireAsset({ orgId, actorUserId, assetId, payload }) {
  const asset = await repo.getAssetWithCategoryAccounts({ orgId, assetId });
  if (!asset) throw new AppError(404, "Asset not found");

  if (asset.status !== "draft") {
    throw new AppError(409, "Only draft assets can be acquired");
  }
  if (asset.category_status !== "active") {
    throw new AppError(409, "Asset category is inactive");
  }

  const costCents = moneyUnits(asset.cost || "0");
  if (costCents <= 0n) throw new AppError(409, "Asset cost must be > 0 to acquire");
  const cost = moneyStringFromUnits(costCents);
  if (!asset.asset_account_id) throw new AppError(409, "Category missing asset_account_id");

  const idempotencyKey = `asset-acq:${orgId}:${assetId}`;

  // 1) Post acquisition journal (Tier 1) via interface
  const draft = await journalIF.createDraftJournal({
    orgId,
    actorUserId,
    payload: {
      periodId: payload.periodId,
      entryDate: payload.entryDate,
      typeCode: "GENERAL",
      memo: payload.memo || `Asset acquisition: ${asset.code} - ${asset.name}`,
      idempotencyKey,
      lines: [
        { accountId: asset.asset_account_id, debit: cost, credit: 0, description: "Asset acquisition" },
        { accountId: payload.fundingAccountId, debit: 0, credit: cost, description: "Funding source" },
      ],
    },
  });

  const posted = await journalIF.postDraftJournal({
    orgId,
    journalId: draft.journalId,
    actorUserId,
  });

  // 2) Persist acquisition link + activate asset
  const updated = await repo.markAcquired({
    orgId,
    assetId,
    actorUserId,
    journalId: posted.journalId,
    memo: payload.memo || null,
  });

  return {
    asset: updated,
    journalId: posted.journalId,
    idempotent: !!draft.idempotent,
  };
}

async function retireAsset({ orgId, actorUserId, assetId }) {
  const out = await repo.updateStatus({ orgId, assetId, status: "retired", tsField: "retired_at" });
  if (!out) throw new AppError(404, "Asset not found");
  return out;
}

async function disposeAsset({ orgId, actorUserId, assetId, payload }) {
  const asset = await repo.getAssetWithCategoryAccounts({ orgId, assetId });
  if (!asset) throw new AppError(404, "Asset not found");

  if (asset.status !== "active") {
    throw new AppError(409, "Only active assets can be disposed");
  }
  if (asset.disposed_at || asset.disposed_date || asset.disposal_journal_entry_id) {
    throw new AppError(409, "Asset already disposed");
  }
  if (asset.category_status !== "active") {
    throw new AppError(409, "Asset category is inactive");
  }

  // Gather needed posting accounts
  const assetAcc = asset.asset_account_id;
  const accumAcc = asset.accum_depr_account_id;
  const gainAcc = asset.disposal_gain_account_id;
  const lossAcc = asset.disposal_loss_account_id;

  if (!assetAcc) throw new AppError(409, "Category missing asset_account_id");
  if (!accumAcc) throw new AppError(409, "Category missing accum_depr_account_id");
  if (!gainAcc) throw new AppError(409, "Category missing disposal_gain_account_id");
  if (!lossAcc) throw new AppError(409, "Category missing disposal_loss_account_id");

  const proceedsCents = moneyUnits(payload.proceeds || "0");
  const proceeds = moneyStringFromUnits(proceedsCents);

  // Reconstruct the asset-account balance from posted valuation events instead of the stale
  // current_value cache. This keeps disposal aligned with the actual GL after revaluations,
  // impairments, depreciation, and reversals.
  const book = await loadAssetBookState({ orgId, asset });
  const grossBookCents = book.grossBookUnits;
  const accumulatedCents = book.accumulatedUnits;
  const grossBook = moneyStringFromUnits(grossBookCents);
  const accumulated = moneyStringFromUnits(accumulatedCents);

  const nbvCents = book.carryingUnits;
  const gainLossCents = proceedsCents - nbvCents;
  const nbv = moneyStringFromUnits(nbvCents);
  const gainLoss = moneyStringFromUnits(gainLossCents);

  const lines = [];

  // Proceeds (if any)
  if (proceedsCents > 0n) {
    lines.push({ accountId: payload.proceedsAccountId, debit: proceeds, credit: "0.00", description: "Disposal proceeds" });
  }

  // Clear accumulated depreciation
  if (accumulatedCents > 0n) {
    lines.push({ accountId: accumAcc, debit: accumulated, credit: "0.00", description: "Reverse accumulated depreciation" });
  }

  // Remove the exact gross asset-account balance, including revaluation/impairment effects.
  lines.push({ accountId: assetAcc, debit: "0.00", credit: grossBook, description: "Asset disposal - remove carrying basis" });

  // Gain/Loss
  if (gainLossCents > 0n) {
    lines.push({ accountId: gainAcc, debit: "0.00", credit: gainLoss, description: "Gain on disposal" });
  } else if (gainLossCents < 0n) {
    lines.push({ accountId: lossAcc, debit: moneyStringFromUnits(absUnits(gainLossCents)), credit: "0.00", description: "Loss on disposal" });
  }

  // Exact balance guard; the journal kernel enforces the same minor-unit invariant.
  const debitCents = sumMoneyUnits(lines.map((line) => line.debit || "0"));
  const creditCents = sumMoneyUnits(lines.map((line) => line.credit || "0"));
  if (debitCents !== creditCents) {
    throw new AppError(500, `Disposal journal not balanced (debit=${moneyStringFromUnits(debitCents)}, credit=${moneyStringFromUnits(creditCents)})`);
  }

  const idempotencyKey = `asset-disp:${orgId}:${assetId}`;

  const draft = await journalIF.createDraftJournal({
    orgId,
    actorUserId,
    payload: {
      periodId: payload.periodId,
      entryDate: payload.entryDate,
      typeCode: "GENERAL",
      memo: payload.memo || `Asset disposal: ${asset.code} - ${asset.name}`,
      idempotencyKey,
      lines,
    },
  });

  const posted = await journalIF.postDraftJournal({
    orgId,
    journalId: draft.journalId,
    actorUserId,
  });

  const updated = await repo.markDisposed({
    orgId,
    assetId,
    actorUserId,
    journalId: posted.journalId,
    entryDate: payload.entryDate,
    proceeds,
    memo: payload.memo || null,
  });

  return {
    asset: updated,
    journalId: posted.journalId,
    idempotent: !!draft.idempotent,
    computed: {
      grossBookValue: moneyNumber(grossBook),
      accumulated: moneyNumber(accumulated),
      nbv: moneyNumber(nbv),
      proceeds: moneyNumber(proceeds),
      gainLoss: moneyNumber(gainLoss),
    },
  };
}

module.exports = {
  createAsset,
  listAssets,
  listDimensionOptions,
  getAssetDetails,
  updateAsset,
  deleteDraftAsset,
  transferAsset,
  revalueAsset,
  impairAsset,
  acquireAsset,
  retireAsset,
  disposeAsset,
};
