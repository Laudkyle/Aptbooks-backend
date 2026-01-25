const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const reportRepo = require("../../reporting/report-builder/reportBuilder.repository");
const { assertSqlSafe, computeNextRunAt } = require("../../reporting/report-builder/reportBuilder.service");

async function runDueSavedReportSchedulesHourly() {
  // Pull a small batch of due schedules and run them.
  const due = await reportRepo.dueSchedules({ limit: 10 });
  let ran = 0;
  for (const sched of due) {
    const organizationId = sched.organization_id;
    const reportId = sched.saved_report_id;
    // Determine version to run (explicit version or latest)
    let version = null;
    if (sched.version_id) {
      const { rows } = await pool.query(
        `SELECT * FROM saved_report_versions WHERE organization_id=$1 AND id=$2 AND saved_report_id=$3 LIMIT 1`,
        [organizationId, sched.version_id, reportId]
      );
      version = rows[0] || null;
    }
    if (!version) {
      version = await reportRepo.getLatestVersion({ organizationId, reportId });
    }
    if (!version) {
      // Cannot run;disable schedule to prevent retries.
      await reportRepo.updateSchedule({ organizationId, scheduleId: sched.id, patch: { isEnabled: false } });
      continue;
    }

    const run = await reportRepo.startRun({ organizationId, reportId, versionId: version.id, scheduleId: sched.id });
    try {
      let rowCount = null;
      let outputJson = null;
      if (version.kind === "sql") {
        const safe = assertSqlSafe(version.query_sql);
        const limited = /\blimit\b/i.test(safe) ? safe : `${safe}\nLIMIT 500`;
        const { rows } = await pool.query(limited, []);
        rowCount = rows.length;
        outputJson = { kind: "sql", rows };
      } else {
        outputJson = { kind: "management", templateKey: version.template_key, parameters: version.parameters_json };
      }
      await reportRepo.finishRun({ organizationId, runId: run.id, status: "success", error: null, rowCount, outputJson });

      // schedule next
      const nextRunAt = computeNextRunAt({
        scheduleType: sched.schedule_type,
        intervalSeconds: sched.interval_seconds,
        dailyHourUtc: sched.daily_hour_utc,
        dailyMinuteUtc: sched.daily_minute_utc,
      });
      await reportRepo.markScheduleRun({ scheduleId: sched.id, nextRunAt });
      ran += 1;
    } catch (e) {
      const msg = String(e?.message || e);
      await reportRepo.finishRun({ organizationId, runId: run.id, status: "failed", error: msg, rowCount: null, outputJson: null });
      // Next run with same schedule (simple retry at next tick)
      const nextRunAt = computeNextRunAt({
        scheduleType: sched.schedule_type,
        intervalSeconds: sched.interval_seconds,
        dailyHourUtc: sched.daily_hour_utc,
        dailyMinuteUtc: sched.daily_minute_utc,
      });
      await reportRepo.updateSchedule({ organizationId, scheduleId: sched.id, patch: { nextRunAt } });
    }
  }

  return { message: `Ran ${ran} saved report schedules`, ran };
}

module.exports = { runDueSavedReportSchedulesHourly };
