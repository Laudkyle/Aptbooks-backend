const { pool } = require("../../db/pool"); 
const logger = require("../../config/logger"); 

// Generic retention cleanup for scheduler operational tables.
// These jobs are safe: they delete only operational logs older than retention.

async function maintenanceRetentionDaily() {
  const retentionDays = Number(process.env.SCHEDULER_RUN_RETENTION_DAYS || 30); 
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString(); 

  const client = await pool.connect(); 
  try {
    await client.query("BEGIN"); 
    const r1 = await client.query(
      `DELETE FROM scheduled_task_runs WHERE started_at < $1::timestamptz`,
      [cutoff]
    ); 
    const r2 = await client.query(
      `DELETE FROM scheduled_task_lock WHERE acquired_at < $1::timestamptz`,
      [cutoff]
    ).catch(() => ({ rowCount: 0 })); 
    await client.query("COMMIT"); 
    logger.info(
      { retentionDays, scheduled_task_runs_deleted: r1.rowCount, scheduled_task_lock_deleted: r2.rowCount },
      "Maintenance retention cleanup complete"
    ); 
  } catch (e) {
    await client.query("ROLLBACK"); 
    logger.warn({ err: e?.message }, "Maintenance retention cleanup failed"); 
    throw e; 
  } finally {
    client.release(); 
  }
}

async function maintenanceRateLimitCleanupDaily() {
  // Only relevant if RATE_LIMIT_STORE=postgres;  safe even if table is missing.
  const retentionDays = Number(process.env.RATE_LIMIT_RETENTION_DAYS || 7); 
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString(); 
  try {
    const r = await pool.query(
      `DELETE FROM rate_limit_windows WHERE reset_at < $1::timestamptz`,
      [cutoff]
    ); 
    logger.info({ retentionDays, rate_limit_windows_deleted: r.rowCount }, "Rate limit window cleanup complete"); 
  } catch (e) {
    // fail-safe: do not break scheduler
    logger.warn({ err: e?.message }, "Rate limit window cleanup failed"); 
  }
}

// Stage 7 / Stage 4: purge expired report cache entries.
// Safe: only deletes rows past expires_at.
async function purgeReportCacheHourly() {
  try {
    const r = await pool.query(
      `DELETE FROM report_cache WHERE expires_at < now()`
    ); 
    logger.info({ report_cache_deleted: r.rowCount }, "Report cache purge complete"); 
    return { deleted: r.rowCount }; 
  } catch (e) {
    // fail-safe
    logger.warn({ err: e?.message }, "Report cache purge failed"); 
    return { deleted: 0, error: String(e?.message || e) }; 
  }
}

// Stage 7 / Stage 4: purge saved report runs according to retention policies.
// If an organization has no explicit policy, use env REPORT_RUNS_RETENTION_DAYS (default 30).
async function purgeSavedReportRunsDaily() {
  const defaultRetentionDays = Number(process.env.REPORT_RUNS_RETENTION_DAYS || 30); 
  const client = await pool.connect(); 
  try {
    await client.query("BEGIN"); 

    // Delete for orgs with explicit policies
    const withPolicy = await client.query(
      `
      DELETE FROM saved_report_runs r
      USING data_retention_policies p
      WHERE r.organization_id = p.organization_id
        AND p.entity_key = 'saved_report_runs'
        AND r.finished_at IS NOT NULL
        AND r.finished_at < (now() - (p.retention_days || ' days')::interval)
      `
    ); 

    // Delete for orgs without policy (default)
    const withoutPolicy = await client.query(
      `
      DELETE FROM saved_report_runs r
      WHERE r.finished_at IS NOT NULL
        AND r.finished_at < (now() - ($1::text || ' days')::interval)
        AND NOT EXISTS (
          SELECT 1 FROM data_retention_policies p
          WHERE p.organization_id = r.organization_id
            AND p.entity_key = 'saved_report_runs'
        )
      `,
      [defaultRetentionDays]
    ); 

    await client.query("COMMIT"); 
    logger.info(
      {
        saved_report_runs_deleted_with_policy: withPolicy.rowCount,
        saved_report_runs_deleted_default: withoutPolicy.rowCount,
        defaultRetentionDays,
      },
      "Saved report runs retention purge complete"
    ); 
    return { withPolicy: withPolicy.rowCount, default: withoutPolicy.rowCount }; 
  } catch (e) {
    await client.query("ROLLBACK"); 
    logger.warn({ err: e?.message }, "Saved report runs retention purge failed"); 
    throw e; 
  } finally {
    client.release(); 
  }
}

module.exports = {
  maintenanceRetentionDaily,
  maintenanceRateLimitCleanupDaily,
  purgeReportCacheHourly,
  purgeSavedReportRunsDaily,
}; 
