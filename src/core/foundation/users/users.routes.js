const router = require("express").Router();
const bcrypt = require("bcrypt"); // <-- FIX: standardize on bcrypt
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { pool } = require("../../../db/pool");
const { env } = require("../../../config/env");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");

router.use(authRequired);

router.post("/", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { email, password } = req.body || {};

    if (!email || !password) throw new AppError(400, "email and password required");
    if (String(password).length < 10) throw new AppError(400, "password must be at least 10 characters");

    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

    const { rows } = await pool.query(
      `
      INSERT INTO users(organization_id, email, password_hash, status)
      VALUES ($1,$2,$3,'active')
      RETURNING id, organization_id, email, status, created_at
      `,
      [orgId, email, passwordHash]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "user.created",
      entityType: "users",
      entityId: rows[0].id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: rows[0]
    });

    res.status(201).json(rows[0]);
  } catch (e) {
    // Global unique email constraint
    if (e && e.code === "23505") {
      return next(new AppError(409, "Email already exists"));
    }
    next(e);
  }
});

router.get("/", requirePermission("users.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(
      `SELECT id, email, status, created_at FROM users WHERE organization_id=$1 ORDER BY created_at DESC`,
      [orgId]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.patch("/:id/disable", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.params.id;

    // Optional safety: prevent disabling yourself
    if (userId === req.user.id) throw new AppError(409, "You cannot disable your own account");

    const { rows: before } = await pool.query(
      `SELECT id, email, status FROM users WHERE organization_id=$1 AND id=$2`,
      [orgId, userId]
    );
    if (!before.length) throw new AppError(404, "User not found");

    const { rows: after } = await pool.query(
      `UPDATE users SET status='disabled', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING id, email, status`,
      [orgId, userId]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "user.disabled",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: before[0],
      after: after[0]
    });

    res.json(after[0]);
  } catch (e) {
    next(e);
  }
});

// Assign roles: { roleIds: ["..."] }
router.post("/:id/roles", requirePermission("rbac.roles.manage"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const orgId = req.user.organization_id;
    const userId = req.params.id;
    const roleIds = req.body?.roleIds || [];

    if (!Array.isArray(roleIds) || roleIds.length === 0) throw new AppError(400, "roleIds required");

    await client.query("BEGIN");

    const { rows: u } = await client.query(
      `SELECT id FROM users WHERE organization_id=$1 AND id=$2`,
      [orgId, userId]
    );
    if (!u.length) throw new AppError(404, "User not found");

    const { rows: roles } = await client.query(
      `SELECT id FROM roles WHERE organization_id=$1 AND id = ANY($2::uuid[])`,
      [orgId, roleIds]
    );
    if (roles.length !== roleIds.length) throw new AppError(400, "One or more roleIds invalid");

    for (const r of roles) {
      await client.query(
        `INSERT INTO user_roles(user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [userId, r.id]
      );
    }

    await client.query("COMMIT");

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "user.roles.assigned",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { userId, roleIds }
    });

    res.json({ userId, assigned: roleIds });
  } catch (e) {
    await client.query("ROLLBACK");
    next(e);
  } finally {
    client.release();
  }
});

module.exports = router;
