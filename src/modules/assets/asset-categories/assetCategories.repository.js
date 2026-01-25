const { pool } = require("../../../db/pool"); 

async function createCategory({ orgId, payload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO asset_categories(
      organization_id, code, name,
      asset_account_id, accum_depr_account_id, depr_expense_account_id,
      disposal_gain_account_id, disposal_loss_account_id,
      status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
    RETURNING *
    `,
    [
      orgId,
      payload.code,
      payload.name,
      payload.assetAccountId,
      payload.accumDeprAccountId,
      payload.deprExpenseAccountId,
      payload.disposalGainAccountId,
      payload.disposalLossAccountId
    ]
  ); 
  return rows[0]; 
}

async function listCategories({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM asset_categories WHERE organization_id=$1 ORDER BY code ASC`,
    [orgId]
  ); 
  return rows; 
}


async function getCategory({ orgId, id }) {
  const { rows } = await pool.query(
    `SELECT * FROM asset_categories WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  ); 
  return rows[0] || null; 
}

async function updateCategory({ orgId, id, payload }) {
  const { rows } = await pool.query(
    `
    UPDATE asset_categories
    SET code=COALESCE($3, code),
        name=COALESCE($4, name),
        asset_account_id=COALESCE($5, asset_account_id),
        accum_depr_account_id=COALESCE($6, accum_depr_account_id),
        depr_expense_account_id=COALESCE($7, depr_expense_account_id),
        disposal_gain_account_id=COALESCE($8, disposal_gain_account_id),
        disposal_loss_account_id=COALESCE($9, disposal_loss_account_id),
        status=COALESCE($10, status),
        updated_at=now()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [
      orgId,
      id,
      payload.code ?? null,
      payload.name ?? null,
      payload.assetAccountId ?? null,
      payload.accumDeprAccountId ?? null,
      payload.deprExpenseAccountId ?? null,
      payload.disposalGainAccountId ?? null,
      payload.disposalLossAccountId ?? null,
      payload.status ?? null
    ]
  ); 
  return rows[0] || null; 
}

async function countAssetsInCategory({ orgId, categoryId }) {
  const { rows } = await pool.query(
    `SELECT COUNT(1)::int AS cnt FROM fixed_assets WHERE organization_id=$1 AND category_id=$2`,
    [orgId, categoryId]
  ); 
  return rows[0]?.cnt || 0; 
}

module.exports = {
  createCategory,
  listCategories,
  getCategory,
  updateCategory,
  countAssetsInCategory
}; 
