const { pool } = require("../../../db/pool");

async function createAsset({ orgId, payload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO fixed_assets(
      organization_id, category_id, code, name,
      acquisition_date, cost, salvage_value,
      status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
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

module.exports = { createAsset, listAssets, updateStatus };
