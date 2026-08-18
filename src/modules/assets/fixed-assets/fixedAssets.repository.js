const { pool } = require("../../../db/pool");

async function createAsset({ orgId, payload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO fixed_assets(
      organization_id, category_id, code, name,
      acquisition_date, cost, salvage_value,
      location_id, department_id, cost_center_id,
      status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft')
    RETURNING *
    `,
    [
      orgId,
      payload.categoryId,
      payload.code,
      payload.name,
      payload.acquisitionDate,
      payload.cost,
      payload.salvageValue ?? 0,
      payload.locationId ?? null,
      payload.departmentId ?? null,
      payload.costCenterId ?? null
    ]
  );
  return rows[0];
}

async function listAssets({ orgId, query }) {
  const params = [orgId];
  const where = ["organization_id=$1"]; 
  let i = 2;

  if (query?.status) { where.push(`status=$${i++}`); params.push(query.status); }
  if (query?.categoryId) { where.push(`category_id=$${i++}`); params.push(query.categoryId); }
  if (query?.locationId) { where.push(`location_id=$${i++}`); params.push(query.locationId); }
  if (query?.departmentId) { where.push(`department_id=$${i++}`); params.push(query.departmentId); }
  if (query?.costCenterId) { where.push(`cost_center_id=$${i++}`); params.push(query.costCenterId); }
  if (query?.q) {
    where.push(`(code ILIKE $${i} OR name ILIKE $${i})`);
    params.push(`%${query.q}%`);
    i++;
  }

  const qualifiedWhere = where.map((clause) => clause
    .replace(/^organization_id/, 'a.organization_id')
    .replace(/^status=/, 'a.status=')
    .replace(/^category_id=/, 'a.category_id=')
    .replace(/^location_id=/, 'a.location_id=')
    .replace(/^department_id=/, 'a.department_id=')
    .replace(/^cost_center_id=/, 'a.cost_center_id=')
    .replace(/^\(code ILIKE/, '(a.code ILIKE')
    .replace(/ OR name ILIKE/, ' OR a.name ILIKE'));

  const { rows } = await pool.query(
    `SELECT a.*,
            ac.name AS category_name,
            ol.code AS location_code, ol.name AS location_name,
            od.code AS department_code, od.name AS department_name,
            cc.code AS cost_center_code, cc.name AS cost_center_name
     FROM fixed_assets a
     LEFT JOIN asset_categories ac ON ac.id=a.category_id AND ac.organization_id=a.organization_id
     LEFT JOIN org_locations ol ON ol.id=a.location_id AND ol.organization_id=a.organization_id
     LEFT JOIN org_departments od ON od.id=a.department_id AND od.organization_id=a.organization_id
     LEFT JOIN cost_centers cc ON cc.id=a.cost_center_id AND cc.organization_id=a.organization_id
     WHERE ${qualifiedWhere.join(" AND ")}
     ORDER BY a.created_at DESC`,
    params
  );
  return rows;
}

async function getAsset({ orgId, assetId }) {
  const { rows } = await pool.query(
    `SELECT * FROM fixed_assets WHERE organization_id=$1 AND id=$2`,
    [orgId, assetId]
  );
  return rows[0] || null;
}

async function getAssetWithCategoryAccounts({ orgId, assetId }) {
  const { rows } = await pool.query(
    `
    SELECT
      a.*,
      c.asset_account_id,
      c.accum_depr_account_id,
      c.depr_expense_account_id,
      c.disposal_gain_account_id,
      c.disposal_loss_account_id,
      c.status AS category_status,
      c.name AS category_name,
      ol.code AS location_code, ol.name AS location_name,
      od.code AS department_code, od.name AS department_name,
      cc.code AS cost_center_code, cc.name AS cost_center_name
    FROM fixed_assets a
    JOIN asset_categories c ON c.id = a.category_id
    LEFT JOIN org_locations ol ON ol.id=a.location_id AND ol.organization_id=a.organization_id
    LEFT JOIN org_departments od ON od.id=a.department_id AND od.organization_id=a.organization_id
    LEFT JOIN cost_centers cc ON cc.id=a.cost_center_id AND cc.organization_id=a.organization_id
    WHERE a.organization_id=$1 AND a.id=$2
    `,
    [orgId, assetId]
  );
  return rows[0] || null;
}

async function updateAsset({ orgId, assetId, payload }) {
  const { rows } = await pool.query(
    `
    UPDATE fixed_assets
    SET category_id = COALESCE($3, category_id),
        code = COALESCE($4, code),
        name = COALESCE($5, name),
        acquisition_date = COALESCE($6, acquisition_date),
        cost = COALESCE($7, cost),
        salvage_value = COALESCE($8, salvage_value),
        location_id = COALESCE($9, location_id),
        department_id = COALESCE($10, department_id),
        cost_center_id = COALESCE($11, cost_center_id),
        status = COALESCE($12, status),
        updated_at = NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [
      orgId,
      assetId,
      payload.categoryId ?? null,
      payload.code ?? null,
      payload.name ?? null,
      payload.acquisitionDate ?? null,
      payload.cost ?? null,
      payload.salvageValue ?? null,
      payload.locationId ?? null,
      payload.departmentId ?? null,
      payload.costCenterId ?? null,
      payload.status ?? null
    ]
  );
  return rows[0] || null;
}

async function deleteDraftAsset({ orgId, assetId }) {
  const { rows } = await pool.query(
    `DELETE FROM fixed_assets WHERE organization_id=$1 AND id=$2 AND status='draft' RETURNING id`,
    [orgId, assetId]
  );
  return rows[0] || null;
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

async function updateCurrentValue({ orgId, assetId, currentValue, impairmentTotal, lastRevaluationAt }) {
  const { rows } = await pool.query(
    `
    UPDATE fixed_assets
    SET current_value=$3,
        impairment_total=COALESCE($4, impairment_total),
        last_revaluation_at=COALESCE($5, last_revaluation_at),
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, assetId, currentValue, impairmentTotal, lastRevaluationAt]
  );
  return rows[0] || null;
}

async function insertAssetEvent({ orgId, assetId, eventType, eventDate, reference, memo, payloadJson, createdBy }) {
  const { rows } = await pool.query(
    `
    INSERT INTO asset_events(organization_id, asset_id, event_type, event_date, reference, memo, payload_json, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
    `,
    [orgId, assetId, eventType, eventDate, reference || null, memo || null, payloadJson ? JSON.stringify(payloadJson) : null, createdBy || null]
  );
  return rows[0];
}

async function listDimensionOptions({ orgId }) {
  const [locations, departments, costCenters] = await Promise.all([
    pool.query(`SELECT id, code, name FROM org_locations WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [orgId]),
    pool.query(`SELECT id, code, name FROM org_departments WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [orgId]),
    pool.query(`SELECT id, code, name FROM cost_centers WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [orgId]),
  ]);
  return { locations: locations.rows, departments: departments.rows, costCenters: costCenters.rows };
}

module.exports = {
  createAsset,
  listDimensionOptions,
  listAssets,
  getAsset,
  getAssetWithCategoryAccounts,
  updateAsset,
  deleteDraftAsset,
  updateStatus,
  markAcquired,
  markDisposed,
  updateCurrentValue,
  insertAssetEvent,
};
