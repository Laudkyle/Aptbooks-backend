const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const { getTask } = require('../../../utilities/scheduled-tasks/taskRegistry');
const { executeTask, runnerId } = require('../../../utilities/scheduled-tasks/schedulerExecution.service');
const { computeNextRunAt } = require('../../../utilities/scheduled-tasks/scheduler');

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
  const { rows } = await pool.query(`SELECT * FROM scheduled_tasks WHERE code=$1`, [code]);
  if (!rows.length) throw new AppError(404, 'Task not found');

  const out = await executeTask({
    task: rows[0],
    handler: taskDef.handler,
    computeNextRunAt,
    triggerType: 'manual',
    actorUserId: actorUserId || null,
    instanceId: `${runnerId()}:manual`,
  });
  if (out.locked) throw new AppError(409, 'Task is already running');
  const { rows: runRows } = await pool.query(`SELECT * FROM scheduled_task_runs WHERE id=$1`, [out.runId]);
  return { data: runRows[0] || out };
}

async function toggle(code, isEnabled) {
  if (!isAccountingTask(code)) throw new AppError(400, 'Task is not an accounting job');
  const { rows } = await pool.query(
    `UPDATE scheduled_tasks SET is_enabled=$2, updated_at=NOW() WHERE code=$1 RETURNING *`,
    [code, isEnabled === true]
  );
  if (!rows.length) throw new AppError(404, 'Task not found');
  return { data: rows[0] };
}

module.exports = { listTasks, listRuns, runNow, toggle };
