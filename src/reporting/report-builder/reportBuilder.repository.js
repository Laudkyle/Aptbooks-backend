const { pool } = require("../../db/pool"); 

async function listReports({ organizationId, includeArchived = false, search = null, limit = 50, offset = 0 }) {
  const params = [organizationId]; 
  let where = `organization_id=$1`; 
  if (!includeArchived) {
    where += ` AND is_archived=FALSE`; 
  }
  if (search) {
    params.push(`%${search}%`); 
    where += ` AND (name ILIKE $${params.length} OR COALESCE(description,'') ILIKE $${params.length})`; 
  }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200)); 
  params.push(Math.max(Number(offset) || 0, 0)); 

  const { rows } = await pool.query(
    `
    SELECT *
    FROM saved_reports
    WHERE ${where}
    ORDER BY updated_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  ); 
  return rows; 
}

async function getReport({ organizationId, reportId }) {
  const { rows } = await pool.query(
    `SELECT * FROM saved_reports WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [organizationId, reportId]
  ); 
  return rows[0] || null; 
}

async function createReport({ organizationId, actorUserId, name, description, folder }) {
  const { rows } = await pool.query(
    `
    INSERT INTO saved_reports(organization_id, name, description, folder, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING *
    `,
    [organizationId, name, description || null, folder || null, actorUserId || null]
  ); 
  return rows[0]; 
}

async function archiveReport({ organizationId, reportId, isArchived }) {
  const { rows } = await pool.query(
    `
    UPDATE saved_reports
    SET is_archived=$3, updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [organizationId, reportId, !!isArchived]
  ); 
  return rows[0] || null; 
}

async function updateReportMeta({ organizationId, reportId, name, description, folder }) {
  const { rows } = await pool.query(
    `
    UPDATE saved_reports
    SET name=COALESCE($3,name),
        description=COALESCE($4,description),
        folder=COALESCE($5,folder),
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [organizationId, reportId, name || null, description ?? null, folder ?? null]
  ); 
  return rows[0] || null; 
}

async function getLatestVersion({ organizationId, reportId }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM saved_report_versions
    WHERE organization_id=$1 AND saved_report_id=$2
    ORDER BY version_number DESC
    LIMIT 1
    `,
    [organizationId, reportId]
  ); 
  return rows[0] || null; 
}

async function listVersions({ organizationId, reportId }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM saved_report_versions
    WHERE organization_id=$1 AND saved_report_id=$2
    ORDER BY version_number DESC
    `,
    [organizationId, reportId]
  ); 
  return rows; 
}

async function createVersion({ organizationId, actorUserId, reportId, kind, querySql, templateKey, parametersJson }) {
  const latest = await getLatestVersion({ organizationId, reportId }); 
  const nextNum = (latest?.version_number || 0) + 1; 

  const { rows } = await pool.query(
    `
    INSERT INTO saved_report_versions(
      organization_id, saved_report_id, version_number,
      kind, query_sql, template_key, parameters_json, created_by_user_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
    `,
    [
      organizationId,
      reportId,
      nextNum,
      kind,
      querySql || null,
      templateKey || null,
      parametersJson ? JSON.stringify(parametersJson) : JSON.stringify({}),
      actorUserId || null,
    ]
  ); 

  await pool.query(
    `UPDATE saved_reports SET updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
    [organizationId, reportId]
  ); 

  return rows[0]; 
}

async function startRun({ organizationId, reportId, versionId, scheduleId }) {
  const { rows } = await pool.query(
    `
    INSERT INTO saved_report_runs(organization_id, saved_report_id, version_id, schedule_id, status)
    VALUES ($1,$2,$3,$4,'running')
    RETURNING *
    `,
    [organizationId, reportId, versionId || null, scheduleId || null]
  ); 
  return rows[0]; 
}

async function finishRun({ organizationId, runId, status, error, rowCount, outputJson }) {
  const { rows } = await pool.query(
    `
    UPDATE saved_report_runs
    SET status=$3,
        finished_at=NOW(),
        error=$4,
        row_count=$5,
        output_json=$6
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [
      organizationId,
      runId,
      status,
      error || null,
      Number.isFinite(rowCount) ? rowCount : null,
      outputJson ? JSON.stringify(outputJson) : null,
    ]
  ); 
  return rows[0] || null; 
}

async function listRuns({ organizationId, reportId, limit = 20 }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM saved_report_runs
    WHERE organization_id=$1 AND saved_report_id=$2
    ORDER BY started_at DESC
    LIMIT $3
    `,
    [organizationId, reportId, Math.min(Math.max(Number(limit) || 20, 1), 200)]
  ); 
  return rows; 
}

// Shares
async function listShares({ organizationId, reportId }) {
  const { rows } = await pool.query(
    `SELECT * FROM saved_report_shares WHERE organization_id=$1 AND saved_report_id=$2 ORDER BY created_at DESC`,
    [organizationId, reportId]
  ); 
  return rows; 
}

async function upsertShare({ organizationId, reportId, shareType, userId, roleId, canEdit }) {
  const { rows } = await pool.query(
    `
    INSERT INTO saved_report_shares(organization_id, saved_report_id, share_type, user_id, role_id, can_edit)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT DO NOTHING
    RETURNING *
    `,
    [organizationId, reportId, shareType, userId || null, roleId || null, !!canEdit]
  ); 
  if (rows.length) return rows[0]; 

  // if already exists, update can_edit
  const { rows: upd } = await pool.query(
    `
    UPDATE saved_report_shares
    SET can_edit=$6, updated_at=NOW()
    WHERE organization_id=$1 AND saved_report_id=$2 AND share_type=$3
      AND COALESCE(user_id,'00000000-0000-0000-0000-000000000000') = COALESCE($4,'00000000-0000-0000-0000-000000000000')
      AND COALESCE(role_id,'00000000-0000-0000-0000-000000000000') = COALESCE($5,'00000000-0000-0000-0000-000000000000')
    RETURNING *
    `,
    [organizationId, reportId, shareType, userId || null, roleId || null, !!canEdit]
  ); 
  return upd[0] || null; 
}

async function deleteShare({ organizationId, shareId }) {
  const { rows } = await pool.query(
    `DELETE FROM saved_report_shares WHERE organization_id=$1 AND id=$2 RETURNING id`,
    [organizationId, shareId]
  ); 
  return !!rows.length; 
}

// Schedules
async function listSchedules({ organizationId, reportId }) {
  const { rows } = await pool.query(
    `SELECT * FROM saved_report_schedules WHERE organization_id=$1 AND saved_report_id=$2 ORDER BY created_at DESC`,
    [organizationId, reportId]
  ); 
  return rows; 
}

async function createSchedule({ organizationId, actorUserId, reportId, versionId, name, schedule }) {
  const { type, intervalSeconds, dailyHourUtc, dailyMinuteUtc } = schedule; 
  const { rows } = await pool.query(
    `
    INSERT INTO saved_report_schedules(
      organization_id, saved_report_id, version_id, name,
      schedule_type, interval_seconds, daily_hour_utc, daily_minute_utc,
      is_enabled, next_run_at, created_by_user_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10)
    RETURNING *
    `,
    [
      organizationId,
      reportId,
      versionId || null,
      name || null,
      type,
      intervalSeconds || null,
      dailyHourUtc ?? null,
      dailyMinuteUtc ?? null,
      null,
      actorUserId || null,
    ]
  ); 
  return rows[0]; 
}

async function updateSchedule({ organizationId, scheduleId, patch }) {
  const { name, isEnabled, versionId, scheduleType, intervalSeconds, dailyHourUtc, dailyMinuteUtc, nextRunAt } = patch; 
  const { rows } = await pool.query(
    `
    UPDATE saved_report_schedules
    SET name=COALESCE($3,name),
        is_enabled=COALESCE($4,is_enabled),
        version_id=COALESCE($5,version_id),
        schedule_type=COALESCE($6,schedule_type),
        interval_seconds=COALESCE($7,interval_seconds),
        daily_hour_utc=COALESCE($8,daily_hour_utc),
        daily_minute_utc=COALESCE($9,daily_minute_utc),
        next_run_at=COALESCE($10,next_run_at),
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [
      organizationId,
      scheduleId,
      name ?? null,
      typeof isEnabled === "boolean" ? isEnabled : null,
      versionId ?? null,
      scheduleType ?? null,
      intervalSeconds ?? null,
      dailyHourUtc ?? null,
      dailyMinuteUtc ?? null,
      nextRunAt ?? null,
    ]
  ); 
  return rows[0] || null; 
}

async function dueSchedules({ limit = 25 }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM saved_report_schedules
    WHERE is_enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at <= NOW()
    ORDER BY next_run_at ASC
    LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 25, 1), 100)]
  ); 
  return rows; 
}

async function markScheduleRun({ scheduleId, nextRunAt }) {
  await pool.query(
    `
    UPDATE saved_report_schedules
    SET last_run_at=NOW(), next_run_at=$2, updated_at=NOW()
    WHERE id=$1
    `,
    [scheduleId, nextRunAt]
  ); 
}

// Comments
async function listComments({ organizationId, reportId, limit = 50 }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM saved_report_comments
    WHERE organization_id=$1 AND saved_report_id=$2
    ORDER BY created_at DESC
    LIMIT $3
    `,
    [organizationId, reportId, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  ); 
  return rows; 
}

async function addComment({ organizationId, reportId, userId, body }) {
  const { rows } = await pool.query(
    `
    INSERT INTO saved_report_comments(organization_id, saved_report_id, user_id, body)
    VALUES ($1,$2,$3,$4)
    RETURNING *
    `,
    [organizationId, reportId, userId || null, body]
  ); 
  return rows[0]; 
}

// Stage 4: report cache
async function getCache({ organizationId, cacheKey }) {
  const { rows } = await pool.query(
    `
    SELECT * FROM report_cache
    WHERE organization_id=$1 AND cache_key=$2 AND expires_at > NOW()
    LIMIT 1
    `,
    [organizationId, cacheKey]
  ); 
  return rows[0] || null; 
}

async function setCache({ organizationId, cacheKey, reportId, reportVersionId, outputJson, rowCount, expiresAt }) {
  const { rows } = await pool.query(
    `
    INSERT INTO report_cache(organization_id, cache_key, report_id, report_version_id, output_json, row_count, expires_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz)
    ON CONFLICT (organization_id, cache_key)
    DO UPDATE SET output_json=EXCLUDED.output_json, row_count=EXCLUDED.row_count, expires_at=EXCLUDED.expires_at, created_at=NOW()
    RETURNING *
    `,
    [organizationId, cacheKey, reportId || null, reportVersionId || null, JSON.stringify(outputJson), rowCount ?? null, expiresAt]
  ); 
  return rows[0]; 
}

async function purgeExpiredCache({ organizationId = null }) {
  if (organizationId) {
    const r = await pool.query(`DELETE FROM report_cache WHERE organization_id=$1 AND expires_at <= NOW()`, [organizationId]); 
    return r.rowCount; 
  }
  const r = await pool.query(`DELETE FROM report_cache WHERE expires_at <= NOW()`); 
  return r.rowCount; 
}

module.exports = {
  listReports,
  getReport,
  createReport,
  updateReportMeta,
  archiveReport,
  listVersions,
  getLatestVersion,
  createVersion,
  startRun,
  finishRun,
  listRuns,
  listShares,
  upsertShare,
  deleteShare,
  listSchedules,
  createSchedule,
  updateSchedule,
  dueSchedules,
  markScheduleRun,
  listComments,
  addComment,
  getCache,
  setCache,
  purgeExpiredCache,
}; 
