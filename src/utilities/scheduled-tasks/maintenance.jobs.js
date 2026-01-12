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
  // Only relevant if RATE_LIMIT_STORE=postgres; safe even if table is missing.
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

module.exports = { maintenanceRetentionDaily, maintenanceRateLimitCleanupDaily };
