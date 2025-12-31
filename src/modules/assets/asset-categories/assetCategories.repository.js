const { pool } = require("../../../db/pool");

async function createCategory({ orgId, payload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO asset_categories(
      organization_id, code, name,
      asset_account_id, accum_depr_account_id, depr_expense_account_id,
      status
    )
    VALUES ($1,$2,$3,$4,$5,$6,'active')
    RETURNING *
    `,
    [orgId, payload.code, payload.name, payload.assetAccountId, payload.accumDeprAccountId, payload.deprExpenseAccountId]
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
