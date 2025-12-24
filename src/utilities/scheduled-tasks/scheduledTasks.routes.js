const router = require("express").Router();
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");

router.use(authRequired);

// List tasks
router.get("/", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_tasks ORDER BY code ASC`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// Enable/disable
router.post("/:code/toggle", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const code = req.params.code;
    const enabled = Boolean(req.body?.enabled);

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
  } catch (e) { next(e); }
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
  } catch (e) { next(e); }
});

module.exports = router;
