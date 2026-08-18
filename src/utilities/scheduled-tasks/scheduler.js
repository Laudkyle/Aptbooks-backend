const { pool } = require("../../db/pool");
const { executeTask, runnerId } = require("./schedulerExecution.service");

let _state = {
  started: false,
  startedAt: null,
  lastTickAt: null,
  lastTickError: null,
  tasksLoaded: 0
};

function getSchedulerState() { return { ..._state }; }

function computeNextRunAt(task, now = new Date()) {
  const scheduleType = task.schedule_type || task.type;
  const intervalSeconds = task.interval_seconds || task.intervalSeconds;
  const dailyHourUtc = task.daily_hour_utc ?? task.dailyHourUtc;
  const dailyMinuteUtc = task.daily_minute_utc ?? task.dailyMinuteUtc;

  if (scheduleType === "interval" || scheduleType === "interval_seconds") {
    const secs = Number(intervalSeconds);
    if (!Number.isFinite(secs) || secs <= 0) throw new Error(`Invalid intervalSeconds: ${intervalSeconds}`);
    return new Date(now.getTime() + secs * 1000);
  }
  if (scheduleType === "daily_at_utc") {
    const hh = Number(dailyHourUtc);
    const mm = Number(dailyMinuteUtc);
    if (!Number.isInteger(hh) || hh < 0 || hh > 23) throw new Error(`Invalid daily_hour_utc: ${dailyHourUtc}`);
    if (!Number.isInteger(mm) || mm < 0 || mm > 59) throw new Error(`Invalid daily_minute_utc: ${dailyMinuteUtc}`);
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  throw new Error(`Unsupported schedule_type: ${scheduleType}`);
}

async function ensureTask({ code, name, schedule }) {
  const nextRunAt = computeNextRunAt({ schedule_type: schedule.type, ...schedule });
  await pool.query(
    `INSERT INTO scheduled_tasks(
       code, name, schedule_type, interval_seconds, daily_hour_utc, daily_minute_utc,
       is_enabled, last_run_at, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE,NULL,$7)
     ON CONFLICT (code) DO UPDATE SET
       name=EXCLUDED.name,
       schedule_type=EXCLUDED.schedule_type,
       interval_seconds=EXCLUDED.interval_seconds,
       daily_hour_utc=EXCLUDED.daily_hour_utc,
       daily_minute_utc=EXCLUDED.daily_minute_utc,
       next_run_at=CASE
         WHEN scheduled_tasks.schedule_type IS DISTINCT FROM EXCLUDED.schedule_type
           OR scheduled_tasks.interval_seconds IS DISTINCT FROM EXCLUDED.interval_seconds
           OR scheduled_tasks.daily_hour_utc IS DISTINCT FROM EXCLUDED.daily_hour_utc
           OR scheduled_tasks.daily_minute_utc IS DISTINCT FROM EXCLUDED.daily_minute_utc
         THEN EXCLUDED.next_run_at ELSE scheduled_tasks.next_run_at END,
       updated_at=NOW()`,
    [code, name, schedule.type, schedule.intervalSeconds || null, schedule.dailyHourUtc ?? null, schedule.dailyMinuteUtc ?? null, nextRunAt]
  );
}

async function startScheduler({ tasks, pollIntervalMs = 5000 }) {
  if (!Array.isArray(tasks)) tasks = [];
  _state = { started: true, startedAt: new Date().toISOString(), lastTickAt: null, lastTickError: null, tasksLoaded: tasks.length };
  for (const t of tasks) await ensureTask({ code: t.code, name: t.name, schedule: t.schedule });

  const instanceId = runnerId();
  async function tick() {
    _state.lastTickAt = new Date().toISOString();
    _state.lastTickError = null;
    const { rows: due } = await pool.query(
      `SELECT * FROM scheduled_tasks
        WHERE is_enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at <= NOW()
        ORDER BY next_run_at ASC LIMIT 5`
    );

    for (const task of due) {
      const handler = tasks.find((x) => x.code === task.code)?.handler;
      if (!handler) {
        await pool.query(`UPDATE scheduled_tasks SET is_enabled=FALSE, updated_at=NOW() WHERE code=$1`, [task.code]);
        continue;
      }
      await executeTask({ task, handler, computeNextRunAt, triggerType: "scheduled", instanceId });
    }
  }

  await tick();
  const intervalId = setInterval(() => {
    tick().catch((e) => { _state.lastTickError = String(e?.message || e); });
  }, pollIntervalMs);

  return {
    started: true,
    tasks: tasks.map((t) => ({ code: t.code, name: t.name })),
    stop: async () => { clearInterval(intervalId); _state.started = false; return { stopped: true }; }
  };
}

module.exports = { startScheduler, getSchedulerState, computeNextRunAt, ensureTask };
