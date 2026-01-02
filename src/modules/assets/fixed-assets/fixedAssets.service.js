const repo = require("./fixedAssets.repository");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const journalIF = require("../../../interfaces/journalPosting.interface");

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
  if (Number(payload.salvageValue || 0) > Number(payload.cost)) {
    throw new AppError(400, "salvageValue cannot exceed cost");
  }
  // Creation is metadata-only. Operational acquisition is performed via /:id/acquire.
  return repo.createAsset({ orgId, payload });
}

async function listAssets({ orgId, query }) {
  return repo.listAssets({ orgId, query });
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

  const cost = Number(asset.cost || 0);
  if (!(cost > 0)) throw new AppError(409, "Asset cost must be > 0 to acquire");
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

  const cost = Number(asset.cost || 0);
  const proceeds = Number(payload.proceeds || 0);

  // Accumulated depreciation across all schedules for this asset
  const { rows: depSum } = await pool.query(
    `
    SELECT COALESCE(SUM(amount),0)::numeric AS amt
    FROM asset_depreciation_transactions
    WHERE organization_id=$1 AND asset_id=$2
    `,
    [orgId, assetId]
  );
  const accumulated = Number(depSum[0].amt || 0);

  const nbv = Number((cost - accumulated).toFixed(2));
  const gainLoss = Number((proceeds - nbv).toFixed(2));

  const lines = [];

  // Proceeds (if any)
  if (proceeds > 0) {
    lines.push({ accountId: payload.proceedsAccountId, debit: proceeds, credit: 0, description: "Disposal proceeds" });
  }

  // Clear accumulated depreciation
  if (accumulated > 0) {
    lines.push({ accountId: accumAcc, debit: accumulated, credit: 0, description: "Reverse accumulated depreciation" });
  }

  // Remove asset cost
  lines.push({ accountId: assetAcc, debit: 0, credit: cost, description: "Asset disposal - remove cost" });

  // Gain/Loss
  if (gainLoss > 0) {
    lines.push({ accountId: gainAcc, debit: 0, credit: gainLoss, description: "Gain on disposal" });
  } else if (gainLoss < 0) {
    lines.push({ accountId: lossAcc, debit: Math.abs(gainLoss), credit: 0, description: "Loss on disposal" });
  }

  // Balance guard (journal service will also guard)
  const debit = Number(lines.reduce((s, l) => s + Number(l.debit || 0), 0).toFixed(2));
  const credit = Number(lines.reduce((s, l) => s + Number(l.credit || 0), 0).toFixed(2));
  if (debit !== credit) {
    throw new AppError(500, `Disposal journal not balanced (debit=${debit}, credit=${credit})`);
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
    computed: { accumulated, nbv, proceeds, gainLoss },
  };
}

module.exports = {
  createAsset,
  listAssets,
  acquireAsset,
  retireAsset,
  disposeAsset,
};
