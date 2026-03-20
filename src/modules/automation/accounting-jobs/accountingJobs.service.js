const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const { getTask } = require('../../../utilities/scheduled-tasks/taskRegistry');

const ACCOUNTING_PREFIXES = ['accruals.', 'assets.', 'ias12.', 'ifrs15.', 'ifrs16.', 'ifrs9.', 'automation.'];
function isAccountingTask(code) { return ACCOUNTING_PREFIXES.some((p) => code.startsWith(p)); }

async function listTasks() {
  const { rows } = await pool.query(`SELECT * FROM scheduled_tasks ORDER BY code ASC`);
  return { data: rows.filter((r) => isAccountingTask(r.code)) };
}

async function listRuns(code, limit = 50) {
  const { rows } = await pool.query(
    `SELECT * FROM scheduled_task_runs WHERE task_code=$1 ORDER BY started_at DESC LIMIT $2`,
    [code, Math.min(Number(limit || 50), 200)]
  );
  return { data: rows };
}

async function runNow(code, actorUserId) {
  if (!isAccountingTask(code)) throw new AppError(400, 'Task is not an accounting job');
  const taskDef = getTask(code);
  if (!taskDef) throw new AppError(404, 'Task handler not registered');
  const { rows: tRows } = await pool.query(`SELECT * FROM scheduled_tasks WHERE code=$1`, [code]);
  if (!tRows.length) throw new AppError(404, 'Task not found');

  const { rows: runRows } = await pool.query(
    `INSERT INTO scheduled_task_runs(task_code, status, message) VALUES ($1,'running',$2) RETURNING *`,
    [code, `Manual accounting job run by ${actorUserId || 'user'}`]
  );
  const run = runRows[0];
  let status = 'success';
  let message = 'OK';
  let errText = null;
  try {
    const out = await taskDef.handler({ task: tRows[0], manual: true });
    if (out?.skipped) { status = 'skipped'; message = out.message || 'Skipped'; }
    else message = out?.message || 'OK';
  } catch (e) {
    status = 'failed'; message = 'Task failed'; errText = String(e?.stack || e?.message || e);
  }
  const { rows } = await pool.query(
    `UPDATE scheduled_task_runs SET status=$2, message=$3, error=$4, finished_at=NOW() WHERE id=$1 RETURNING *`,
    [run.id, status, message, errText]
  );
  await pool.query(`UPDATE scheduled_tasks SET last_run_at=NOW(), updated_at=NOW() WHERE code=$1`, [code]);
  return { data: rows[0] };
}

async function toggle(code, isEnabled) {
  if (!isAccountingTask(code)) throw new AppError(400, 'Task is not an accounting job');
  const { rows } = await pool.query(
    `UPDATE scheduled_tasks SET is_enabled=$2, updated_at=NOW() WHERE code=$1 RETURNING *`,
    [code, !!isEnabled]
  );
  if (!rows.length) throw new AppError(404, 'Task not found');
  return { data: rows[0] };
}

module.exports = { listTasks, listRuns, runNow, toggle };
