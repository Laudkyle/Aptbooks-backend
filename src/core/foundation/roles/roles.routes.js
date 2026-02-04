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

// Matrix view: roles with permissions
router.get("/matrix", requirePermission("rbac.roles.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(
      `
      SELECT r.id AS role_id, r.name AS role_name, p.code AS permission_code
        FROM roles r
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE r.organization_id=$1
       ORDER BY r.name, p.code
      `,
      [orgId]
    );

    const map = {};
    for (const row of rows) {
      if (!map[row.role_id]) map[row.role_id] = { id: row.role_id, name: row.role_name, permissions: [] };
      if (row.permission_code) map[row.role_id].permissions.push(row.permission_code);
    }
    res.json({ data: Object.values(map) });
  } catch (e) { next(e); }
});

// Get role permissions
router.get("/:id/permissions", requirePermission("rbac.roles.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const roleId = req.params.id;

    const { rows: r } = await pool.query(`SELECT id, name FROM roles WHERE organization_id=$1 AND id=$2`, [orgId, roleId]);
    if (!r.length) throw new AppError(404, "Role not found");

    const { rows: perms } = await pool.query(
      `
      SELECT p.id, p.code
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id=$1
      ORDER BY p.code
      `,
      [roleId]
    );

    res.json({ role: r[0], permissions: perms });
  } catch (e) { next(e); }
});

// Update role (rename)
router.patch("/:id", requirePermission("rbac.roles.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const roleId = req.params.id;
    const name = req.body?.name;
    if (!name) throw new AppError(400, "name required");

    const { rows: before } = await pool.query(`SELECT * FROM roles WHERE organization_id=$1 AND id=$2`, [orgId, roleId]);
    if (!before.length) throw new AppError(404, "Role not found");

    const { rows: after } = await pool.query(
      `UPDATE roles SET name=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, roleId, name]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "role.updated",
      entityType: "roles",
      entityId: roleId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: before[0],
      after: after[0]
    });

    res.json(after[0]);
  } catch (e) { next(e); }
});

// Detach permissions from role: { permissionCodes: ["..."] }
router.delete("/:id/permissions", requirePermission("rbac.roles.manage"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const orgId = req.user.organization_id;
    const roleId = req.params.id;
    const codes = req.body?.permissionCodes || [];
    if (!Array.isArray(codes) || codes.length === 0) throw new AppError(400, "permissionCodes required");

    await client.query("BEGIN");
    const { rows: r } = await client.query(`SELECT id FROM roles WHERE organization_id=$1 AND id=$2`, [orgId, roleId]);
    if (!r.length) throw new AppError(404, "Role not found");

    const { rows: perms } = await client.query(`SELECT id, code FROM permissions WHERE code = ANY($1::text[])`, [codes]);
    if (perms.length !== codes.length) throw new AppError(400, "One or more permission codes invalid");

    await client.query(
      `DELETE FROM role_permissions WHERE role_id=$1 AND permission_id = ANY($2::uuid[])`,
      [roleId, perms.map((p) => p.id)]
    );
    await client.query("COMMIT");

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "role.permissions.detached",
      entityType: "roles",
      entityId: roleId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { roleId, permissionCodes: codes }
    });

    res.json({ roleId, detached: codes });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    next(e);
  } finally {
    client.release();
  }
});

// Delete role
router.delete("/:id", requirePermission("rbac.roles.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const roleId = req.params.id;
    const { rows: before } = await pool.query(`SELECT * FROM roles WHERE organization_id=$1 AND id=$2`, [orgId, roleId]);
    if (!before.length) throw new AppError(404, "Role not found");

    await pool.query(`DELETE FROM roles WHERE organization_id=$1 AND id=$2`, [orgId, roleId]);

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "role.deleted",
      entityType: "roles",
      entityId: roleId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: before[0]
    });

    res.json({ ok: true });
  } catch (e) {
    // if foreign key fails, show safe message
    if (e && e.code === "23503") return next(new AppError(409, "Role is in use and cannot be deleted"));
    next(e);
  }
});

// Apply preset templates
router.post("/templates", requirePermission("rbac.roles.manage"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const orgId = req.user.organization_id;
    const template = String(req.body?.template || "").toLowerCase();
    if (!template) throw new AppError(400, "template required");

    const presets = {
      admin: { name: "Admin", include: ["%"] },
      accountant: { name: "Accountant", include: ["accounting.%", "reporting.%", "banking.%", "tax.%", "settings.read"] },
      clerk: { name: "Clerk", include: ["accounting.%read%", "modules.%read%", "banking.%read%", "settings.read"] },
      viewer: { name: "Viewer", include: ["%read%", "settings.read"] }
    };
    const preset = presets[template];
    if (!preset) throw new AppError(400, "Unknown template");

    await client.query("BEGIN");

    // role upsert by name
    const { rows: roleRows } = await client.query(
      `INSERT INTO roles(organization_id, name) VALUES ($1,$2)
       ON CONFLICT (organization_id, name) DO UPDATE SET name=EXCLUDED.name
       RETURNING id, name`,
      [orgId, preset.name]
    );
    const roleId = roleRows[0].id;

    // load matching permissions
    let permRows = [];
    if (preset.include[0] === "%") {
      const r = await client.query(`SELECT id, code FROM permissions ORDER BY code`);
      permRows = r.rows;
    } else {
      // build OR LIKE
      const likes = preset.include;
      const conditions = likes.map((_, i) => `code LIKE $${i + 1}`).join(" OR ");
      const r = await client.query(`SELECT id, code FROM permissions WHERE ${conditions} ORDER BY code`, likes);
      permRows = r.rows;
    }

    for (const p of permRows) {
      await client.query(`INSERT INTO role_permissions(role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roleId, p.id]);
    }

    await client.query("COMMIT");

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "role.template.applied",
      entityType: "roles",
      entityId: roleId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { template, roleId, permissionCount: permRows.length }
    });

    res.status(201).json({ roleId, roleName: preset.name, permissionCount: permRows.length });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    next(e);
  } finally {
    client.release();
  }
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
