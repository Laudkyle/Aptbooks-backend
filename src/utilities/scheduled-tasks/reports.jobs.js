const { pool } = require('../../db/pool');
const { bindTenant } = require('../../shared/security/tenantContext');
const reportRepo = require('../../reporting/report-builder/reportBuilder.repository');
const { assertSqlSafe, computeNextRunAt } = require('../../reporting/report-builder/reportBuilder.service');

async function runDueSavedReportSchedulesHourly() {
  const { rows: organizations } = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC`);
  let ran = 0;

  for (const organization of organizations) {
    const organizationId = organization.id;
    bindTenant(organizationId);
    const due = await reportRepo.dueSchedules({ organizationId, limit: 10 });

    for (const sched of due) {
      const reportId = sched.saved_report_id;
      let version = null;
      if (sched.version_id) {
        const { rows } = await pool.query(
          `SELECT * FROM saved_report_versions WHERE organization_id=$1 AND id=$2 AND saved_report_id=$3 LIMIT 1`,
          [organizationId, sched.version_id, reportId]
        );
        version = rows[0] || null;
      }
      if (!version) version = await reportRepo.getLatestVersion({ organizationId, reportId });
      if (!version) {
        await reportRepo.updateSchedule({ organizationId, scheduleId: sched.id, patch: { isEnabled: false } });
        continue;
      }

      const run = await reportRepo.startRun({ organizationId, reportId, versionId: version.id, scheduleId: sched.id });
      try {
        let rowCount = null;
        let outputJson = null;
        if (version.kind === 'sql') {
          const safe = assertSqlSafe(version.query_sql);
          const limited = /\blimit\b/i.test(safe) ? safe : `${safe}\nLIMIT 500`;
          const { rows } = await pool.query(limited, []);
          rowCount = rows.length;
          outputJson = { kind: 'sql', rows };
        } else {
          outputJson = { kind: 'management', templateKey: version.template_key, parameters: version.parameters_json };
        }
        await reportRepo.finishRun({ organizationId, runId: run.id, status: 'success', error: null, rowCount, outputJson });
        const nextRunAt = computeNextRunAt({
          scheduleType: sched.schedule_type,
          intervalSeconds: sched.interval_seconds,
          dailyHourUtc: sched.daily_hour_utc,
          dailyMinuteUtc: sched.daily_minute_utc,
        });
        await reportRepo.markScheduleRun({ organizationId, scheduleId: sched.id, nextRunAt });
        ran += 1;
      } catch (error) {
        const message = String(error?.message || error);
        await reportRepo.finishRun({ organizationId, runId: run.id, status: 'failed', error: message, rowCount: null, outputJson: null });
        const nextRunAt = computeNextRunAt({
          scheduleType: sched.schedule_type,
          intervalSeconds: sched.interval_seconds,
          dailyHourUtc: sched.daily_hour_utc,
          dailyMinuteUtc: sched.daily_minute_utc,
        });
        await reportRepo.updateSchedule({ organizationId, scheduleId: sched.id, patch: { nextRunAt } });
      }
    }
  }

  return { message: `Ran ${ran} saved report schedules`, ran };
}

module.exports = { runDueSavedReportSchedulesHourly };
