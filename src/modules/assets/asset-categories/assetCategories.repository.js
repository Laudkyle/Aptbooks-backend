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

module.exports = { createCategory, listCategories };
