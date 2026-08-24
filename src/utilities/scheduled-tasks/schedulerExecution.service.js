const os = require("os");
const { pool } = require("../../db/pool");
const { metrics } = require("../../observability/metrics.registry");

function lockKeyFromCode(code) {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

function runnerId() {
  return `${os.hostname()}:${process.pid}`;
}

function computeBackoff(attemptCount) {
  const minutes = [1, 5, 15, 60][Math.min(Math.max(attemptCount - 1, 0), 3)];
  return new Date(Date.now() + minutes * 60 * 1000);
}

/**
 * Execute one task under the same PostgreSQL session advisory lock for both
 * scheduled and manual triggers. The run row is inserted exactly once and then
 * transitioned in place to its terminal state.
 */
async function executeTask({ task, handler, computeNextRunAt, triggerType = "scheduled", actorUserId = null, instanceId = runnerId() }) {
  const startedNs = process.hrtime.bigint();
  const client = await pool.connect();
  const lockKey = lockKeyFromCode(task.code);
  let locked = false;
  let runId = null;
  let finalized = false;

  try {
    const { rows: lockRows } = await client.query(`SELECT pg_try_advisory_lock($1) AS ok`, [lockKey]);
    locked = !!lockRows[0]?.ok;
    if (!locked) {
      metrics.schedulerRuns.inc({ task: task.code, status: "locked" });
      metrics.schedulerDuration.observe({ task: task.code, status: "locked" }, Number(process.hrtime.bigint() - startedNs) / 1e9);
      return { skipped: true, locked: true, message: "Task is already running" };
    }

    await client.query(
      `UPDATE scheduled_tasks SET locked_at=NOW(), locked_by=$2, updated_at=NOW() WHERE code=$1`,
      [task.code, instanceId]
    );
    const { rows: runRows } = await client.query(
      `INSERT INTO scheduled_task_runs(task_code, status, message, runner_id, trigger_type, actor_user_id)
       VALUES($1,'running',$2,$3,$4,$5) RETURNING id`,
      [task.code, `Started by ${instanceId}`, instanceId, triggerType, actorUserId]
    );
    runId = runRows[0].id;

    let status = "success";
    let message = "OK";
    let error = null;
    try {
      const result = await handler({ task, manual: triggerType === "manual" });
      if (result?.skipped) {
        status = "skipped";
        message = result.message || "Skipped";
      } else {
        message = result?.message || "OK";
      }
    } catch (e) {
      status = "failed";
      message = "Task failed";
      error = String(e?.stack || e?.message || e);
    }

    await client.query("BEGIN");
    let attemptCount = Number(task.attempt_count || 0);
    if (status === "failed" && triggerType === "scheduled") {
      attemptCount += 1;
      if (attemptCount >= Number(task.max_attempts || 5)) {
        await client.query(
          `UPDATE scheduled_tasks
              SET is_enabled=FALSE, attempt_count=$2, locked_at=NULL, locked_by=NULL, updated_at=NOW()
            WHERE code=$1`,
          [task.code, attemptCount]
        );
      } else {
        await client.query(
          `UPDATE scheduled_tasks
              SET attempt_count=$2, next_run_at=$3, locked_at=NULL, locked_by=NULL, updated_at=NOW()
            WHERE code=$1`,
          [task.code, attemptCount, computeBackoff(attemptCount)]
        );
      }
    } else if (status === "failed") {
      // A failed operator-triggered run must not consume the scheduler's retry
      // budget, disable the task, or move its automatic next-run time.
      await client.query(
        `UPDATE scheduled_tasks
            SET locked_at=NULL, locked_by=NULL, updated_at=NOW()
          WHERE code=$1`,
        [task.code]
      );
    } else if (triggerType === "scheduled") {
      await client.query(
        `UPDATE scheduled_tasks
            SET last_run_at=NOW(), next_run_at=$2, attempt_count=0,
                locked_at=NULL, locked_by=NULL, updated_at=NOW()
          WHERE code=$1`,
        [task.code, computeNextRunAt(task)]
      );
    } else {
      // A manual run records last success but does not move the persisted schedule.
      await client.query(
        `UPDATE scheduled_tasks
            SET last_run_at=NOW(), attempt_count=0, locked_at=NULL, locked_by=NULL, updated_at=NOW()
          WHERE code=$1`,
        [task.code]
      );
    }

    await client.query(
      `UPDATE scheduled_task_runs
          SET status=$2, message=$3, error=$4, finished_at=NOW()
        WHERE id=$1 AND status='running'`,
      [runId, status, message, error]
    );
    await client.query("COMMIT");
    finalized = true;
    const durationSeconds = Number(process.hrtime.bigint() - startedNs) / 1e9;
    metrics.schedulerRuns.inc({ task: task.code, status });
    metrics.schedulerDuration.observe({ task: task.code, status }, durationSeconds);
    if (status === "failed") metrics.schedulerFailures.inc({ task: task.code });
    return { runId, status, message, error };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    if (runId && !finalized) {
      try {
        await client.query(
          `UPDATE scheduled_task_runs
              SET status='failed', message='Scheduler infrastructure failure', error=$2, finished_at=NOW()
            WHERE id=$1 AND status='running'`,
          [runId, String(e?.stack || e?.message || e)]
        );
      } catch (_) {}
    }
    try {
      await client.query(`UPDATE scheduled_tasks SET locked_at=NULL, locked_by=NULL, updated_at=NOW() WHERE code=$1`, [task.code]);
    } catch (_) {}
    metrics.schedulerRuns.inc({ task: task.code, status: "infrastructure_failed" });
    metrics.schedulerFailures.inc({ task: task.code });
    metrics.schedulerDuration.observe({ task: task.code, status: "infrastructure_failed" }, Number(process.hrtime.bigint() - startedNs) / 1e9);
    throw e;
  } finally {
    if (locked) {
      try { await client.query(`SELECT pg_advisory_unlock($1)`, [lockKey]); } catch (_) {}
    }
    client.release();
  }
}

module.exports = { executeTask, lockKeyFromCode, runnerId };
