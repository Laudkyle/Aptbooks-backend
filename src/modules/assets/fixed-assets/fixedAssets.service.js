const repo = require("./fixedAssets.repository");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

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
  return repo.createAsset({ orgId, payload });
}

async function listAssets({ orgId, query }) {
  return repo.listAssets({ orgId, query });
}

async function retireAsset({ orgId, actorUserId, assetId }) {
  const out = await repo.updateStatus({ orgId, assetId, status: "retired", tsField: "retired_at" });
  if (!out) throw new AppError(404, "Asset not found");
  return out;
}

async function disposeAsset({ orgId, actorUserId, assetId }) {
  const out = await repo.updateStatus({ orgId, assetId, status: "disposed", tsField: "disposed_at" });
  if (!out) throw new AppError(404, "Asset not found");
  return out;
}

module.exports = { createAsset, listAssets, retireAsset, disposeAsset };
