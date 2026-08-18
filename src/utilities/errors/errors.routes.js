const router = require("express").Router();
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");

router.use(authRequired);

// List errors with basic filtering
router.get("/", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const limit = Math.min(Number(req.query.limit || 50) || 50, 200);
    const status = req.query.status ? Number(req.query.status) : null;
    const method = req.query.method ? String(req.query.method).toUpperCase() : null;
    const path = req.query.path ? String(req.query.path) : null;
    const correlationId = req.query.correlationId ? String(req.query.correlationId) : null;

    if (!orgId) throw new AppError(403, "Organization context required");
    const params = [orgId];
    let where = "WHERE organization_id=$1";
    if (status) {
      params.push(status);
      where += ` AND status=$${params.length}`;
    }
    if (method) {
      params.push(method);
      where += ` AND method=$${params.length}`;
    }
    if (path) {
      params.push(path);
      where += ` AND path LIKE ($${params.length} || '%')`;
    }
    if (correlationId) {
      params.push(correlationId);
      where += ` AND correlation_id=$${params.length}`;
    }
    params.push(limit);

    const { rows } = await pool.query(
      `
      SELECT id, created_at, organization_id, correlation_id, method, path, status, message, user_id
      FROM error_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}
      `,
      params
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// Error statistics
router.get("/stats/summary/", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    if (!orgId) throw new AppError(403, "Organization context required");
    const days = Math.min(Number(req.query.days || 7) || 7, 90);
    const { rows } = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status >= 500)::int AS server_errors,
        COUNT(*) FILTER (WHERE status BETWEEN 400 AND 499)::int AS client_errors,
        COUNT(DISTINCT correlation_id)::int AS unique_correlations
      FROM error_logs
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND organization_id=$2
      `,
      [days, orgId]
    );

    const { rows: top } = await pool.query(
      `
      SELECT COALESCE(path,'') AS path, COUNT(*)::int AS count
      FROM error_logs
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND organization_id=$2
      GROUP BY COALESCE(path,'')
      ORDER BY count DESC
      LIMIT 10
      `,
      [days, orgId]
    );

    res.json({ summary: rows[0] || { total: 0, server_errors: 0, client_errors: 0, unique_correlations: 0 }, top_paths: top });
  } catch (e) { next(e); }
});

// Get by correlation id
router.get("/:correlationId", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const correlationId = String(req.params.correlationId);
    if (!correlationId) throw new AppError(400, "correlationId required");

    const orgId = req.user.organization_id;
    if (!orgId) throw new AppError(403, "Organization context required");
    const { rows } = await pool.query(
      `
      SELECT id, created_at, organization_id, correlation_id, method, path, status, message, user_id
      FROM error_logs
      WHERE correlation_id=$1
        AND organization_id=$2
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [correlationId, orgId]
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

module.exports = router;
