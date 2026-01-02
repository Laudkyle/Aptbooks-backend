const { pool } = require("../../../db/pool");

async function createAsset({ orgId, payload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO fixed_assets(
      organization_id, category_id, code, name,
      acquisition_date, cost, salvage_value,
      status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,'draft')
    RETURNING *
    `,
    [orgId, payload.categoryId, payload.code, payload.name, payload.acquisitionDate, payload.cost, payload.salvageValue ?? 0]
  );
  return rows[0];
}

async function listAssets({ orgId, query }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;

  if (query?.status) { where.push(`status=$${i++}`); params.push(query.status); }
  if (query?.categoryId) { where.push(`category_id=$${i++}`); params.push(query.categoryId); }

  const { rows } = await pool.query(
    `SELECT * FROM fixed_assets WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
    params
  );
  return rows;
}

async function getAssetWithCategoryAccounts({ orgId, assetId }) {
  const { rows } = await pool.query(
    `
    SELECT
      a.*,
      c.asset_account_id,
      c.accum_depr_account_id,
      c.disposal_gain_account_id,
      c.disposal_loss_account_id,
      c.status AS category_status
    FROM fixed_assets a
    JOIN asset_categories c ON c.id = a.category_id
    WHERE a.organization_id=$1 AND a.id=$2
    `,
    [orgId, assetId]
  );
  return rows[0];
}

async function updateStatus({ orgId, assetId, status, tsField }) {
  const { rows } = await pool.query(
    `
    UPDATE fixed_assets
    SET status=$3, ${tsField}=NOW(), updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, assetId, status]
  );
  return rows[0];
}

async function markAcquired({ orgId, assetId, actorUserId, journalId, memo }) {
  const { rows } = await pool.query(
    `
    UPDATE fixed_assets
    SET status='active',
        acquired_at=NOW(),
        acquired_by=$4,
        acquisition_journal_entry_id=$3,
        acquisition_memo=$5,
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, assetId, journalId, actorUserId, memo || null]
  );
  return rows[0];
}

async function markDisposed({ orgId, assetId, actorUserId, journalId, entryDate, proceeds, memo }) {
  const { rows } = await pool.query(
    `
    UPDATE fixed_assets
    SET status='disposed',
        disposed_at=NOW(),
        disposed_date=$4,
        disposal_proceeds=$5,
        disposal_journal_entry_id=$3,
        disposed_by=$6,
        disposal_memo=$7,
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, assetId, journalId, entryDate, proceeds, actorUserId, memo || null]
  );
  return rows[0];
}

module.exports = {
  createAsset,
  listAssets,
  getAssetWithCategoryAccounts,
  updateStatus,
  markAcquired,
  markDisposed,
};
