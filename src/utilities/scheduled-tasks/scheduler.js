const os = require("os");
const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");

function utcNow() { return new Date(); }

function computeNextRunAt(task) {
  const now = utcNow();

  if (task.schedule_type === "interval_seconds") {
    const seconds = Number(task.interval_seconds || 0);
    if (!seconds) throw new AppError(500, `Task ${task.code} missing interval_seconds`);
    return new Date(now.getTime() + seconds * 1000);
  }

  if (task.schedule_type === "daily_at_utc") {
    const h = Number(task.daily_hour_utc);
    const m = Number(task.daily_minute_utc);

    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      h, m, 0, 0
    ));

    // if already passed today, schedule tomorrow
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
  }

  throw new AppError(500, `Unknown schedule_type: ${task.schedule_type}`);
}

// Deterministic 32-bit advisory lock key from task_code
function lockKeyFromCode(code) {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Signed 32-bit
  return h | 0;
}

async function ensureTask({ code, name, schedule }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(`SELECT * FROM scheduled_tasks WHERE code=$1 LIMIT 1`, [code]);

    if (!rows.length) {
      const now = utcNow();
      const nextRunAt = computeNextRunAt({ schedule_type: schedule.type, ...schedule });

      await client.query(
        `
        INSERT INTO scheduled_tasks(
          code, name, schedule_type, interval_seconds,
          daily_hour_utc, daily_minute_utc,
          is_enabled, last_run_at, next_run_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,TRUE,NULL,$7)
        `,
        [
          code, name,
          schedule.type,
          schedule.intervalSeconds || null,
          schedule.dailyHourUtc ?? null,
          schedule.dailyMinuteUtc ?? null,
          nextRunAt
        ]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function markRun({ taskCode, status, message, error }) {
  await pool.query(
    `
    INSERT INTO scheduled_task_runs(task_code, status, message, error, finished_at)
    VALUES ($1,$2,$3,$4,NOW())
    `,
    [taskCode, status, message || null, error || null]
  );
}

async function startScheduler({ tasks, pollIntervalMs = 5000 }) {
  // Ensure tasks exist in DB (persisted schedules)
  for (const t of tasks) {
    await ensureTask({ code: t.code, name: t.name, schedule: t.schedule });
  }

  const instanceId = `${os.hostname()}:${process.pid}`;

  async function tick() {
    const client = await pool.connect();
    try {
      // pick due tasks
      const { rows: due } = await client.query(
        `
        SELECT * FROM scheduled_tasks
        WHERE is_enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at <= NOW()
        ORDER BY next_run_at ASC
        LIMIT 5
        `
      );

      for (const task of due) {
        const handler = tasks.find(x => x.code === task.code)?.handler;
        if (!handler) {
          // disable unknown task
          await client.query(
            `UPDATE scheduled_tasks SET is_enabled=FALSE, updated_at=NOW() WHERE code=$1`,
            [task.code]
          );
          await markRun({ taskCode: task.code, status: "failed", message: "No handler registered", error: null });
          continue;
        }

        // Advisory lock ensures single runner across restarts / multi-instances
        const lockKey = lockKeyFromCode(task.code);
        const { rows: lockRows } = await client.query(`SELECT pg_try_advisory_lock($1) AS ok`, [lockKey]);
        if (!lockRows[0]?.ok) continue;

        // mark DB lock
        await client.query(
          `
          UPDATE scheduled_tasks
          SET locked_at=NOW(), locked_by=$2
          WHERE code=$1
          `,
          [task.code, instanceId]
        );

        // log run start
        await client.query(
          `INSERT INTO scheduled_task_runs(task_code, status, message) VALUES($1,'running',$2)`,
          [task.code, `Started by ${instanceId}`]
        );

        let status = "success";
        let message = "OK";
        let errText = null;

        try {
          const result = await handler({ task });
          if (result?.skipped) {
            status = "skipped";
            message = result.message || "Skipped";
          } else {
            message = result?.message || "OK";
          }
        } catch (e) {
          status = "failed";
          message = "Task failed";
          errText = String(e?.stack || e?.message || e);
        }

        // update schedule regardless of outcome (with retry behaviour)
        const now = utcNow();
        let attemptCount = Number(task.attempt_count || 0);
        let nextRunAt;

        if (status === "failed") {
          attemptCount += 1;

          if (attemptCount >= Number(task.max_attempts || 5)) {
            // disable after max attempts
            await client.query(
              `
              UPDATE scheduled_tasks
              SET is_enabled=FALSE,
                  attempt_count=$2,
                  locked_at=NULL, locked_by=NULL,
                  updated_at=NOW()
              WHERE code=$1
              `,
              [task.code, attemptCount]
            );
          } else {
            // backoff: 1m, 5m, 15m, 60m...
            const backoffMinutes = [1, 5, 15, 60][Math.min(attemptCount - 1, 3)];
            nextRunAt = new Date(now.getTime() + backoffMinutes * 60 * 1000);

            await client.query(
              `
              UPDATE scheduled_tasks
              SET attempt_count=$2,
                  next_run_at=$3,
                  locked_at=NULL, locked_by=NULL,
                  updated_at=NOW()
              WHERE code=$1
              `,
              [task.code, attemptCount, nextRunAt]
            );
          }
        } else {
          // reset attempts and compute next schedule time
          nextRunAt = computeNextRunAt(task);
          await client.query(
            `
            UPDATE scheduled_tasks
            SET last_run_at=NOW(),
                next_run_at=$2,
                attempt_count=0,
                locked_at=NULL, locked_by=NULL,
                updated_at=NOW()
            WHERE code=$1
            `,
            [task.code, nextRunAt]
          );
        }

        await markRun({ taskCode: task.code, status, message, error: errText });

        // release advisory lock
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
      }
    } finally {
      client.release();
    }
  }

  // Run immediately then poll
  await tick();
  setInterval(() => tick().catch(() => {}), pollIntervalMs);
}

module.exports = { startScheduler };
