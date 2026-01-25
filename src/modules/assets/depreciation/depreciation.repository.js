const { pool } = require("../../../db/pool"); 
const { AppError } = require("../../../shared/errors/AppError"); 

/**
 * Option A schedule fields:
 * - effectiveStartDate: required for clean multi-schedule semantics
 * - effectiveEndDate: nullable
 * - componentCode: nullable (for component depreciation / revaluations)
 *
 * Backwards compatibility:
 * - If effectiveStartDate not provided, fall back to depreciationStartDate
 */
async function createSchedule({ orgId, payload }) {
  const effectiveStartDate = payload.effectiveStartDate || payload.depreciationStartDate; 
  const effectiveEndDate = payload.effectiveEndDate || null; 
  const componentCode = payload.componentCode || null; 

  if (!effectiveStartDate) {
    throw new AppError(400, "effectiveStartDate (or depreciationStartDate) is required"); 
  }

 
  const { rows: overlap } = await pool.query(
    `
    SELECT id
    FROM asset_depreciation_schedules
    WHERE organization_id=$1
      AND asset_id=$2
      AND status='active'
      AND effective_start_date <= COALESCE($4::date, '9999-12-31'::date)
      AND COALESCE(effective_end_date, '9999-12-31'::date) >= $3::date
    LIMIT 1
    `,
    [orgId, payload.assetId, effectiveStartDate, effectiveEndDate]
  ); 

  if (overlap.length) {
    throw new AppError(409, "Overlapping active depreciation schedule exists for asset"); 
  }

  const { rows } = await pool.query(
    `
    INSERT INTO asset_depreciation_schedules(
      organization_id,
      asset_id,
      method,
      useful_life_months,
      depreciation_start_date,
      effective_start_date,
      effective_end_date,
      component_code,
      status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
    RETURNING *
    `,
    [
      orgId,
      payload.assetId,
      payload.method || "straight_line",
      payload.usefulLifeMonths,
      payload.depreciationStartDate || effectiveStartDate, // keep legacy column populated
      effectiveStartDate,
      effectiveEndDate,
      componentCode
    ]
  ); 

  return rows[0]; 
}

async function listSchedules({ orgId, query }) {
  const params = [orgId]; 
  const where = ["s.organization_id=$1"]; 
  let i = 2; 

  if (query?.status) {
    where.push(`s.status=$${i++}`); 
    params.push(query.status); 
  }

  if (query?.activeOnly === "true") {
    where.push(`s.status='active'`); 
  }

  if (query?.assetId) {
    where.push(`s.asset_id=$${i++}`); 
    params.push(query.assetId); 
  }

  if (query?.componentCode) {
    where.push(`s.component_code=$${i++}`); 
    params.push(query.componentCode); 
  }

  // Useful to query “what schedules are effective as of date X”
  // Includes open-ended schedules
  if (query?.effectiveOnDate) {
    where.push(`s.effective_start_date <= $${i++}::date`); 
    params.push(query.effectiveOnDate); 

    where.push(`(s.effective_end_date IS NULL OR s.effective_end_date >= $${i++}::date)`); 
    params.push(query.effectiveOnDate); 
  }

  const { rows } = await pool.query(
    `
    SELECT
      s.*,
      a.code AS asset_code,
      a.name AS asset_name,
      a.status AS asset_status,
      a.cost,
      a.salvage_value,
      a.disposed_date,
      a.disposed_at,
      c.code AS category_code,
      c.name AS category_name
    FROM asset_depreciation_schedules s
    JOIN fixed_assets a ON a.id=s.asset_id
    JOIN asset_categories c ON c.id=a.category_id
    WHERE ${where.join(" AND ")}
    ORDER BY a.code ASC, COALESCE(s.component_code,'') ASC, s.effective_start_date DESC, s.created_at DESC
    `,
    params
  ); 

  return rows; 
}

async function getSchedule({ orgId, scheduleId }) {
  const { rows } = await pool.query(
    `SELECT * FROM asset_depreciation_schedules WHERE organization_id=$1 AND id=$2`,
    [orgId, scheduleId]
  ); 
  return rows[0] || null; 
}

async function updateSchedule({ orgId, scheduleId, payload }) {
  const { rows } = await pool.query(
    `
    UPDATE asset_depreciation_schedules
    SET method = COALESCE($3, method),
        useful_life_months = COALESCE($4, useful_life_months),
        effective_start_date = COALESCE($5, effective_start_date),
        effective_end_date = COALESCE($6, effective_end_date),
        status = COALESCE($7, status),
        updated_at = NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [
      orgId,
      scheduleId,
      payload.method ?? null,
      payload.usefulLifeMonths ?? null,
      payload.effectiveStartDate ?? null,
      payload.effectiveEndDate ?? null,
      payload.status ?? null,
    ]
  ); 
  return rows[0] || null; 
}

async function deleteScheduleIfNoPostings({ orgId, scheduleId }) {
  const { rows: txRows } = await pool.query(
    `SELECT 1 FROM asset_depreciation_transactions WHERE organization_id=$1 AND schedule_id=$2 LIMIT 1`,
    [orgId, scheduleId]
  ); 
  if (txRows.length) {
    throw new AppError(409, "Cannot delete schedule with posted depreciation transactions"); 
  }
  const { rows } = await pool.query(
    `DELETE FROM asset_depreciation_schedules WHERE organization_id=$1 AND id=$2 RETURNING id`,
    [orgId, scheduleId]
  ); 
  return rows[0] || null; 
}

module.exports = {
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  deleteScheduleIfNoPostings,
}; 
