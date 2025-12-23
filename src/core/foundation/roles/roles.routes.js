const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");

router.use(authRequired);

router.post("/", requirePermission("rbac.roles.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { name } = req.body || {};
    if (!name) throw new AppError(400, "name required");

    const { rows } = await pool.query(
      `INSERT INTO roles(organization_id, name) VALUES ($1,$2) RETURNING *`,
      [orgId, name]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "role.created",
      entityType: "roles",
      entityId: rows[0].id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: rows[0]
    });

    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.get("/", requirePermission("rbac.roles.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(`SELECT * FROM roles WHERE organization_id=$1 ORDER BY name`, [orgId]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Attach permissions to role: { permissionCodes: ["..."] }
router.post("/:id/permissions", requirePermission("rbac.roles.manage"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const orgId = req.user.organization_id;
    const roleId = req.params.id;
    const codes = req.body?.permissionCodes || [];
    if (!Array.isArray(codes) || codes.length === 0) throw new AppError(400, "permissionCodes required");

    await client.query("BEGIN");

    const { rows: r } = await client.query(
      `SELECT id FROM roles WHERE organization_id=$1 AND id=$2`,
      [orgId, roleId]
    );
    if (!r.length) throw new AppError(404, "Role not found");

    const { rows: perms } = await client.query(
      `SELECT id, code FROM permissions WHERE code = ANY($1::text[])`,
      [codes]
    );
    if (perms.length !== codes.length) throw new AppError(400, "One or more permission codes invalid");

    for (const p of perms) {
      await client.query(
        `INSERT INTO role_permissions(role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [roleId, p.id]
      );
    }

    await client.query("COMMIT");

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "role.permissions.attached",
      entityType: "roles",
      entityId: roleId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { roleId, permissionCodes: codes }
    });

    res.json({ roleId, attached: codes });
  } catch (e) {
    await client.query("ROLLBACK");
    next(e);
  } finally {
    client.release();
  }
});

module.exports = router;
