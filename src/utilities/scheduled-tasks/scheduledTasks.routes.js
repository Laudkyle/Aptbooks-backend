const router = require("express").Router(); 
const { authRequired } = require("../../middleware/auth.middleware"); 
const { requirePermission } = require("../../middleware/permission.middleware"); 
const { pool } = require("../../db/pool"); 
const { AppError } = require("../../shared/errors/AppError"); 
const { getTask } = require("./taskRegistry"); 

router.use(authRequired); 

// List tasks
router.get("/", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_tasks ORDER BY code ASC`
    ); 
    res.json(rows); 
  } catch (e) { next(e);  }
}); 

// Enable/disable
router.post("/:code/:status/toggle", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const code = req.params.code; 
    const enabled = Boolean(req.params.status); 
    const { rows } = await pool.query(
      `
      UPDATE scheduled_tasks
      SET is_enabled=$2,
          updated_at=NOW()
      WHERE code=$1
      RETURNING *
      `,
      [code, enabled]
    ); 
    if (!rows.length) throw new AppError(404, "Task not found"); 
    res.json(rows[0]); 
  } catch (e) { next(e);  }
}); 

// View recent runs for a task
router.get("/:code/runs", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const code = req.params.code; 
    const limit = Math.min(Number(req.query?.limit || 50), 200); 

    const { rows } = await pool.query(
      `
      SELECT * FROM scheduled_task_runs
      WHERE task_code=$1
      ORDER BY started_at DESC
      LIMIT $2
      `,
      [code, limit]
    ); 

    res.json(rows); 
  } catch (e) { next(e);  }
}); 

// Run a task now (synchronously)
router.post("/:code/run", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const code = req.params.code; 
    const taskDef = getTask(code); 
    if (!taskDef) throw new AppError(404, "Task handler not registered"); 

    // Ensure task exists
    const { rows: tRows } = await pool.query(`SELECT * FROM scheduled_tasks WHERE code=$1`, [code]); 
    if (!tRows.length) throw new AppError(404, "Task not found"); 

    // Create a run row
    const { rows: runRows } = await pool.query(
      `INSERT INTO scheduled_task_runs(task_code, status, message) VALUES ($1,'running',$2) RETURNING *`,
      [code, `Manual run by ${req.user?.id || 'user'}`]
    ); 
    const run = runRows[0]; 

    let status = "success"; 
    let message = "OK"; 
    let errText = null; 

    try {
      const out = await taskDef.handler({ task: tRows[0], manual: true }); 
      if (out?.skipped) {
        status = "skipped"; 
        message = out.message || "Skipped"; 
      } else {
        message = out?.message || "OK"; 
      }
    } catch (e) {
      status = "failed"; 
      message = "Task failed"; 
      errText = String(e?.stack || e?.message || e); 
    }

    const { rows: doneRows } = await pool.query(
      `UPDATE scheduled_task_runs SET status=$2, message=$3, error=$4, finished_at=NOW() WHERE id=$1 RETURNING *`,
      [run.id, status, message, errText]
    ); 

    // Update last_run_at and next_run_at for manual run only if success
    await pool.query(
      `UPDATE scheduled_tasks SET last_run_at=NOW(), updated_at=NOW() WHERE code=$1`,
      [code]
    ); 

    res.json(doneRows[0]); 
  } catch (e) { next(e);  }
}); 

// Run details
router.get("/:code/runs/:runId", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const code = req.params.code; 
    const runId = req.params.runId; 
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_task_runs WHERE task_code=$1 AND id=$2 LIMIT 1`,
      [code, runId]
    ); 
    if (!rows.length) throw new AppError(404, "Run not found"); 
    res.json(rows[0]); 
  } catch (e) { next(e);  }
}); 

module.exports = router; 
