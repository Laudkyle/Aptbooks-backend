const { pool } = require("../../../db/pool");

function db(client) { return client || pool; }

async function createAsset({ orgId, payload, client = null }) {
  const { rows } = await db(client).query(
    `INSERT INTO fixed_assets(
       organization_id, category_id, code, name, acquisition_date, in_service_date,
       cost, salvage_value, location_id, department_id, cost_center_id,
       asset_tag, serial_number, manufacturer, model, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'draft')
     RETURNING *`,
    [orgId, payload.categoryId, payload.code, payload.name, payload.acquisitionDate,
      payload.inServiceDate || null, payload.cost, payload.salvageValue ?? 0,
      payload.locationId ?? null, payload.departmentId ?? null, payload.costCenterId ?? null,
      payload.assetTag || null, payload.serialNumber || null, payload.manufacturer || null, payload.model || null]
  );
  return rows[0];
}

async function listAssets({ orgId, query, client = null }) {
  const params = [orgId];
  const where = ["a.organization_id=$1"];
  let i = 2;
  if (query?.status) { where.push(`a.status=$${i++}`); params.push(query.status); }
  if (query?.categoryId) { where.push(`a.category_id=$${i++}`); params.push(query.categoryId); }
  if (query?.locationId) { where.push(`a.location_id=$${i++}`); params.push(query.locationId); }
  if (query?.departmentId) { where.push(`a.department_id=$${i++}`); params.push(query.departmentId); }
  if (query?.costCenterId) { where.push(`a.cost_center_id=$${i++}`); params.push(query.costCenterId); }
  if (query?.q) {
    where.push(`(a.code ILIKE $${i} OR a.name ILIKE $${i} OR COALESCE(a.asset_tag,'') ILIKE $${i} OR COALESCE(a.serial_number,'') ILIKE $${i})`);
    params.push(`%${query.q}%`);
    i++;
  }
  const { rows } = await db(client).query(
    `SELECT a.*, ac.name AS category_name, ac.code AS category_code,
            ol.code AS location_code, ol.name AS location_name,
            od.code AS department_code, od.name AS department_name,
            cc.code AS cost_center_code, cc.name AS cost_center_name,
            COALESCE(dep.accumulated_depreciation,0)::numeric AS accumulated_depreciation,
            (a.cost + COALESCE(rev.revaluation_delta,0) - COALESCE(dep.accumulated_depreciation,0) - COALESCE(a.impairment_total,0))::numeric AS carrying_amount
       FROM fixed_assets a
       LEFT JOIN asset_categories ac ON ac.id=a.category_id AND ac.organization_id=a.organization_id
       LEFT JOIN org_locations ol ON ol.id=a.location_id AND ol.organization_id=a.organization_id
       LEFT JOIN org_departments od ON od.id=a.department_id AND od.organization_id=a.organization_id
       LEFT JOIN cost_centers cc ON cc.id=a.cost_center_id AND cc.organization_id=a.organization_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(t.amount),0) AS accumulated_depreciation
           FROM asset_depreciation_transactions t
          WHERE t.organization_id=a.organization_id AND t.asset_id=a.id
       ) dep ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN e.payload_json ? 'delta' THEN (e.payload_json->>'delta')::numeric ELSE 0 END),0) AS revaluation_delta
           FROM asset_events e
          WHERE e.organization_id=a.organization_id AND e.asset_id=a.id AND e.event_type='revaluation'
       ) rev ON TRUE
      WHERE ${where.join(" AND ")}
      ORDER BY a.created_at DESC`, params);
  return rows;
}

async function getAsset({ orgId, assetId, client = null, forUpdate = false }) {
  const { rows } = await db(client).query(
    `SELECT * FROM fixed_assets WHERE organization_id=$1 AND id=$2${forUpdate ? ' FOR UPDATE' : ''}`,
    [orgId, assetId]
  );
  return rows[0] || null;
}

async function getAssetWithCategoryAccounts({ orgId, assetId, client = null, forUpdate = false }) {
  const { rows } = await db(client).query(
    `SELECT a.*,
            c.asset_account_id, c.accum_depr_account_id, c.depr_expense_account_id,
            c.disposal_gain_account_id, c.disposal_loss_account_id,
            c.default_depreciation_method, c.default_useful_life_months,
            c.default_depreciation_convention, c.default_declining_rate_percent,
            c.status AS category_status, c.name AS category_name, c.code AS category_code,
            ol.code AS location_code, ol.name AS location_name,
            od.code AS department_code, od.name AS department_name,
            cc.code AS cost_center_code, cc.name AS cost_center_name
       FROM fixed_assets a
       JOIN asset_categories c ON c.id=a.category_id AND c.organization_id=a.organization_id
       LEFT JOIN org_locations ol ON ol.id=a.location_id AND ol.organization_id=a.organization_id
       LEFT JOIN org_departments od ON od.id=a.department_id AND od.organization_id=a.organization_id
       LEFT JOIN cost_centers cc ON cc.id=a.cost_center_id AND cc.organization_id=a.organization_id
      WHERE a.organization_id=$1 AND a.id=$2${forUpdate ? ' FOR UPDATE OF a' : ''}`,
    [orgId, assetId]
  );
  return rows[0] || null;
}

async function updateAsset({ orgId, assetId, payload, client = null }) {
  const fieldMap = {
    categoryId: 'category_id', code: 'code', name: 'name', acquisitionDate: 'acquisition_date',
    inServiceDate: 'in_service_date', cost: 'cost', salvageValue: 'salvage_value',
    locationId: 'location_id', departmentId: 'department_id', costCenterId: 'cost_center_id',
    assetTag: 'asset_tag', serialNumber: 'serial_number', manufacturer: 'manufacturer', model: 'model',
    status: 'status', retirementReason: 'retirement_reason',
  };
  const sets = [];
  const params = [orgId, assetId];
  let idx = 3;
  for (const [key, column] of Object.entries(fieldMap)) {
    if (Object.prototype.hasOwnProperty.call(payload || {}, key)) {
      sets.push(`${column}=$${idx++}`);
      params.push(payload[key] === '' ? null : payload[key]);
    }
  }
  if (!sets.length) return getAsset({ orgId, assetId, client });
  sets.push('updated_at=NOW()');
  const { rows } = await db(client).query(
    `UPDATE fixed_assets SET ${sets.join(', ')} WHERE organization_id=$1 AND id=$2 RETURNING *`, params);
  return rows[0] || null;
}

async function deleteDraftAsset({ orgId, assetId, client = null }) {
  const { rows } = await db(client).query(
    `DELETE FROM fixed_assets WHERE organization_id=$1 AND id=$2 AND status='draft' RETURNING id`, [orgId, assetId]);
  return rows[0] || null;
}

async function updateStatus({ orgId, assetId, status, tsField, reason = null, client = null }) {
  const allowedTs = new Set(['retired_at', 'disposed_at']);
  if (!allowedTs.has(tsField)) throw new Error('Invalid asset lifecycle timestamp field');
  const { rows } = await db(client).query(
    `UPDATE fixed_assets
        SET status=$3, ${tsField}=NOW(), retirement_reason=CASE WHEN $3='retired' THEN $4 ELSE retirement_reason END, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, assetId, status, reason]);
  return rows[0] || null;
}

async function markAcquired({ orgId, assetId, actorUserId, journalId, memo, entryDate, client = null }) {
  const { rows } = await db(client).query(
    `UPDATE fixed_assets
        SET status='active', acquired_at=NOW(), acquired_by=$4,
            acquisition_journal_entry_id=$3, acquisition_memo=$5,
            in_service_date=COALESCE(in_service_date,$6::date,acquisition_date), updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status='draft'
      RETURNING *`, [orgId, assetId, journalId, actorUserId, memo || null, entryDate || null]);
  return rows[0] || null;
}

async function markDisposed({ orgId, assetId, actorUserId, journalId, entryDate, proceeds, memo, client = null }) {
  const { rows } = await db(client).query(
    `UPDATE fixed_assets
        SET status='disposed', disposed_at=NOW(), disposed_date=$4,
            disposal_proceeds=$5, disposal_journal_entry_id=$3,
            disposed_by=$6, disposal_memo=$7, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status IN ('active','retired')
      RETURNING *`, [orgId, assetId, journalId, entryDate, proceeds, actorUserId, memo || null]);
  return rows[0] || null;
}

async function updateCurrentValue({ orgId, assetId, currentValue, impairmentTotal, lastRevaluationAt, client = null }) {
  const { rows } = await db(client).query(
    `UPDATE fixed_assets
        SET current_value=$3,
            impairment_total=COALESCE($4, impairment_total),
            last_revaluation_at=COALESCE($5, last_revaluation_at), updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, assetId, currentValue, impairmentTotal, lastRevaluationAt]);
  return rows[0] || null;
}

async function insertAssetEvent({ orgId, assetId, eventType, eventDate, reference, memo, payloadJson, createdBy, client = null }) {
  const { rows } = await db(client).query(
    `INSERT INTO asset_events(organization_id, asset_id, event_type, event_date, reference, memo, payload_json, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [orgId, assetId, eventType, eventDate, reference || null, memo || null,
      payloadJson ? JSON.stringify(payloadJson) : null, createdBy || null]);
  return rows[0];
}

async function listDimensionOptions({ orgId, client = null }) {
  const database = db(client);
  const [locations, departments, costCenters] = await Promise.all([
    database.query(`SELECT id, code, name FROM org_locations WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [orgId]),
    database.query(`SELECT id, code, name FROM org_departments WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [orgId]),
    database.query(`SELECT id, code, name FROM cost_centers WHERE organization_id=$1 AND status='active' ORDER BY code, name`, [orgId]),
  ]);
  return { locations: locations.rows, departments: departments.rows, costCenters: costCenters.rows };
}

async function createDimension({ orgId, type, code, name, client = null }) {
  const table = type === 'location' ? 'org_locations' : type === 'department' ? 'org_departments' : null;
  if (!table) throw new Error('Unsupported asset dimension type');
  const { rows } = await db(client).query(
    `INSERT INTO ${table}(organization_id, code, name, status)
     VALUES ($1,$2,$3,'active') RETURNING id, code, name, status`, [orgId, code, name]);
  return rows[0];
}

async function overview({ orgId, client = null }) {
  const database = db(client);
  const [{ rows: totals }, { rows: readiness }, { rows: recent }] = await Promise.all([
    database.query(
      `WITH asset_totals AS (
         SELECT COUNT(*)::int AS asset_count,
                COUNT(*) FILTER (WHERE status='draft')::int AS draft_count,
                COUNT(*) FILTER (WHERE status='active')::int AS active_count,
                COUNT(*) FILTER (WHERE status='retired')::int AS retired_count,
                COALESCE(SUM(cost) FILTER (WHERE status IN ('active','retired')),0)::numeric AS gross_cost,
                COALESCE(SUM(impairment_total) FILTER (WHERE status IN ('active','retired')),0)::numeric AS impairment_total
           FROM fixed_assets WHERE organization_id=$1
       ), depreciation AS (
         SELECT COALESCE(SUM(amount),0)::numeric AS accumulated_depreciation
           FROM asset_depreciation_transactions WHERE organization_id=$1
       ), revaluations AS (
         SELECT COALESCE(SUM(CASE WHEN payload_json ? 'delta' THEN (payload_json->>'delta')::numeric ELSE 0 END),0)::numeric AS revaluation_total
           FROM asset_events WHERE organization_id=$1 AND event_type='revaluation'
       )
       SELECT a.*, d.accumulated_depreciation, r.revaluation_total,
              (a.gross_cost + r.revaluation_total - d.accumulated_depreciation - a.impairment_total)::numeric AS carrying_amount
         FROM asset_totals a CROSS JOIN depreciation d CROSS JOIN revaluations r`, [orgId]),
    database.query(
      `SELECT
          COUNT(*) FILTER (WHERE a.status='active' AND a.acquisition_journal_entry_id IS NULL)::int AS active_without_acquisition,
          COUNT(*) FILTER (WHERE a.status='active' AND NOT EXISTS (
             SELECT 1 FROM asset_depreciation_schedules s
              WHERE s.organization_id=a.organization_id AND s.asset_id=a.id AND s.status='active'
          ))::int AS active_without_schedule,
          COUNT(*) FILTER (WHERE a.status='active' AND a.salvage_value > a.cost)::int AS invalid_residual
       FROM fixed_assets a WHERE a.organization_id=$1`, [orgId]),
    database.query(
      `SELECT e.id, e.asset_id, e.event_type, e.event_date, e.memo, a.code AS asset_code, a.name AS asset_name
         FROM asset_events e JOIN fixed_assets a ON a.id=e.asset_id AND a.organization_id=e.organization_id
        WHERE e.organization_id=$1 ORDER BY e.event_date DESC, e.created_at DESC LIMIT 8`, [orgId]),
  ]);
  return {
    // Monetary values remain PostgreSQL NUMERIC strings end-to-end; presentation code never
    // participates in carrying-value arithmetic.
    totals: totals[0] || {},
    readiness: readiness[0] || {}, recentEvents: recent,
  };
}

module.exports = {
  createAsset, listDimensionOptions, createDimension, overview, listAssets, getAsset,
  getAssetWithCategoryAccounts, updateAsset, deleteDraftAsset, updateStatus, markAcquired,
  markDisposed, updateCurrentValue, insertAssetEvent,
};
