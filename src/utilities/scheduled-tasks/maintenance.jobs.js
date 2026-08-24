const { pool } = require('../../db/pool');
const { bindTenant } = require('../../shared/security/tenantContext');
const logger = require('../../config/logger');

async function organizationIds() {
  const { rows } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);
  return rows.map((row) => row.id);
}

// Generic retention cleanup for scheduler operational tables. These tables are
// global scheduler infrastructure and intentionally excluded from tenant RLS.
async function maintenanceRetentionDaily() {
  const retentionDays = Number(process.env.SCHEDULER_RUN_RETENTION_DAYS || 30);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r1 = await client.query(`DELETE FROM scheduled_task_runs WHERE started_at < $1::timestamptz`, [cutoff]);
    const r2 = await client.query(`DELETE FROM scheduled_task_lock WHERE acquired_at < $1::timestamptz`, [cutoff]).catch(() => ({ rowCount: 0 }));
    await client.query('COMMIT');
    logger.info({ retentionDays, scheduled_task_runs_deleted: r1.rowCount, scheduled_task_lock_deleted: r2.rowCount }, 'Maintenance retention cleanup complete');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.warn({ err: error?.message }, 'Maintenance retention cleanup failed');
    throw error;
  } finally {
    client.release();
  }
}

async function maintenanceRateLimitCleanupDaily() {
  const retentionDays = Number(process.env.RATE_LIMIT_RETENTION_DAYS || 7);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    const result = await pool.query(`DELETE FROM rate_limit_windows WHERE reset_at < $1::timestamptz`, [cutoff]);
    logger.info({ retentionDays, rate_limit_windows_deleted: result.rowCount }, 'Rate limit window cleanup complete');
  } catch (error) {
    logger.warn({ err: error?.message }, 'Rate limit window cleanup failed');
  }
}

async function purgeReportCacheHourly() {
  let deleted = 0;
  for (const organizationId of await organizationIds()) {
    bindTenant(organizationId);
    try {
      const result = await pool.query(
        `DELETE FROM report_cache WHERE organization_id=$1 AND expires_at < now()`,
        [organizationId]
      );
      deleted += result.rowCount;
    } catch (error) {
      logger.warn({ organizationId, err: error?.message }, 'Report cache purge failed for tenant');
    }
  }
  logger.info({ report_cache_deleted: deleted }, 'Report cache purge complete');
  return { deleted };
}

async function purgeSavedReportRunsDaily() {
  const defaultRetentionDays = Number(process.env.REPORT_RUNS_RETENTION_DAYS || 30);
  let withPolicyDeleted = 0;
  let defaultDeleted = 0;

  for (const organizationId of await organizationIds()) {
    bindTenant(organizationId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const withPolicy = await client.query(
        `DELETE FROM saved_report_runs r
          USING data_retention_policies p
          WHERE r.organization_id=$1
            AND p.organization_id=$1
            AND r.organization_id=p.organization_id
            AND p.entity_key='saved_report_runs'
            AND r.finished_at IS NOT NULL
            AND r.finished_at < (now() - (p.retention_days || ' days')::interval)`,
        [organizationId]
      );
      const withoutPolicy = await client.query(
        `DELETE FROM saved_report_runs r
          WHERE r.organization_id=$1
            AND r.finished_at IS NOT NULL
            AND r.finished_at < (now() - ($2::text || ' days')::interval)
            AND NOT EXISTS (
              SELECT 1 FROM data_retention_policies p
               WHERE p.organization_id=$1 AND p.entity_key='saved_report_runs'
            )`,
        [organizationId, defaultRetentionDays]
      );
      await client.query('COMMIT');
      withPolicyDeleted += withPolicy.rowCount;
      defaultDeleted += withoutPolicy.rowCount;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.warn({ organizationId, err: error?.message }, 'Saved report runs retention purge failed for tenant');
      throw error;
    } finally {
      client.release();
    }
  }

  logger.info({
    saved_report_runs_deleted_with_policy: withPolicyDeleted,
    saved_report_runs_deleted_default: defaultDeleted,
    defaultRetentionDays,
  }, 'Saved report runs retention purge complete');
  return { withPolicy: withPolicyDeleted, default: defaultDeleted };
}

module.exports = {
  maintenanceRetentionDaily,
  maintenanceRateLimitCleanupDaily,
  purgeReportCacheHourly,
  purgeSavedReportRunsDaily,
};
